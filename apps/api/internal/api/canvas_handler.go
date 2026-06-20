package api

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// validateLatLng rejects coordinates Leaflet can't place — non-finite values or
// values out of the geographic range. The message is written for the agent: a
// pin.add/pin.update over MCP fails loudly with what's wrong and how to fix it
// (the #1 real case is swapping lat/lng — a longitude in the latitude slot is
// out of [-90,90], and Web-Mercator can't project it, which yields NaN). Returns
// "" when valid.
func validateLatLng(lat, lng float64) string {
	if math.IsNaN(lat) || math.IsInf(lat, 0) || math.IsNaN(lng) || math.IsInf(lng, 0) {
		return fmt.Sprintf("pin coordinates must be finite numbers (got lat=%v, lng=%v). Please set a valid lat/lng and try again.", lat, lng)
	}
	if lat < -90 || lat > 90 {
		return fmt.Sprintf("pin latitude %v is out of range — it must be between -90 and 90. Did you swap lat and lng? Please correct the coordinates.", lat)
	}
	if lng < -180 || lng > 180 {
		return fmt.Sprintf("pin longitude %v is out of range — it must be between -180 and 180. Did you swap lat and lng? Please correct the coordinates.", lng)
	}
	return ""
}

type Handler struct {
	store store.Store
	hub   *ws.Hub
	maps  *maps.Registry
}

func NewHandler(s store.Store, hub *ws.Hub, mapsReg *maps.Registry) *Handler {
	return &Handler{store: s, hub: hub, maps: mapsReg}
}

// POST /api/canvases
func (h *Handler) CreateCanvas(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil || body.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	// Owned only when a logged-in human creates it (OptionalUser middleware).
	// MCP/gateway creates have no session cookie → anonymous, as intended.
	var owner *uuid.UUID
	if uid, ok := UserIDFromCtx(r.Context()); ok {
		owner = &uid
	}
	canvas, err := h.store.CreateCanvas(r.Context(), body.Name, owner)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, canvas)
}

// GET /api/canvases/{code}
func (h *Handler) GetCanvasByCode(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	canvas, err := h.store.GetCanvasByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	writeJSON(w, http.StatusOK, canvas)
}

// GET /api/me/canvases  (RequireUser) — the signed-in user's owned canvases.
func (h *Handler) MeCanvases(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	canvases, err := h.store.ListCanvasesByOwner(r.Context(), uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, canvases)
}

// POST /api/canvases/{code}/copy  (RequireUser) — deep-copy a canvas into one
// owned by the signed-in user. This is how you "own" an anonymous canvas.
func (h *Handler) CopyCanvas(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	src, err := h.store.GetCanvasByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	_ = decode(r, &body)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = src.Name
	}
	canvas, err := h.store.CopyCanvas(r.Context(), src.ID, uid, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, canvas)
}

// POST /api/canvases/{code}/claim  (RequireUser) — take ownership of an
// anonymous canvas (e.g. one Claude created) using its one-time claim token.
// Unlike copy, this assigns the SAME canvas to the user, so an agent already
// editing it keeps writing to the canvas the user now owns. First valid claim
// wins; the token is single-use.
func (h *Handler) ClaimCanvas(w http.ResponseWriter, r *http.Request) {
	uid, ok := UserIDFromCtx(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not signed in")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Token) == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}
	code := chi.URLParam(r, "code")
	canvas, err := h.store.ClaimCanvas(r.Context(), code, strings.TrimSpace(body.Token), uid)
	if errors.Is(err, store.ErrCanvasNotClaimable) {
		// Wrong token, wrong code, or already claimed — all 409 so we don't leak
		// which canvases exist or are still unclaimed.
		writeError(w, http.StatusConflict, "canvas is not claimable (already claimed or invalid token)")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, canvas)
}

// GET /api/stats  (public) — total canvases + user accounts created. The
// canvas count feeds the landing social-proof number; the user count is for
// tracking adoption (not displayed on the landing).
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	canvases, err := h.store.CanvasCount(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	users, err := h.store.UserCount(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	recurring, _, err := h.store.CanvasRecurrence(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// % of canvases touched again on a later day — the recurrence proxy. Integer
	// round-half-up so we don't drag in math just for one percentage.
	pct := 0
	if canvases > 0 {
		pct = (recurring*100 + canvases/2) / canvases
	}
	writeJSON(w, http.StatusOK, map[string]int{
		"canvases":     canvases,
		"users":        users,
		"recurring":    recurring,
		"recurringPct": pct,
	})
}

// GET /api/canvas/state  (JWT required)
func (h *Handler) GetState(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	canvas, state, edits, err := h.store.GetCanvasState(r.Context(), canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stateMsg{
		Type:         "state",
		Canvas:       canvas,
		State:        state,
		PendingEdits: edits,
	})
}

// POST /api/canvas/mode  (JWT required)
func (h *Handler) SetMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !isValidMode(body.Mode) {
		writeError(w, http.StatusBadRequest, "invalid mode")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.SetMode(r.Context(), canvasID, body.Mode); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// EnableMode turns on a tab the user added via "+", even before it has content.
// POST /api/canvas/mode/enable  (JWT required)
func (h *Handler) EnableMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !isEnableableMode(body.Mode) {
		writeError(w, http.StatusBadRequest, "invalid mode")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.EnableMode(r.Context(), canvasID, body.Mode); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/map  (JWT required)
func (h *Handler) SetMap(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MapID string `json:"mapId"`
	}
	if err := decode(r, &body); err != nil || body.MapID == "" {
		writeError(w, http.StatusBadRequest, "mapId is required")
		return
	}
	if h.maps == nil || !h.maps.Has(body.MapID) {
		writeError(w, http.StatusBadRequest, "unknown mapId")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.SetMapID(r.Context(), canvasID, body.MapID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/template  (JWT required)
func (h *Handler) ApplyTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TemplateID string  `json:"templateId"`
		Mode       string  `json:"mode"`
		MapID      *string `json:"mapId,omitempty"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !isValidMode(body.Mode) {
		writeError(w, http.StatusBadRequest, "invalid mode")
		return
	}
	if body.MapID != nil && (h.maps == nil || !h.maps.Has(*body.MapID)) {
		writeError(w, http.StatusBadRequest, "unknown mapId")
		return
	}
	canvasID := CanvasIDFromCtx(r.Context())
	if _, err := h.store.ApplyTemplate(r.Context(), canvasID, body.Mode, body.MapID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func isValidMode(mode string) bool {
	switch mode {
	case "welcome", "map", "itinerary", "docs", "roadmap", "sheets", "charts":
		return true
	}
	return false
}

// isEnableableMode is isValidMode minus "welcome" — welcome is the template
// picker, not a content tab a user can add.
func isEnableableMode(mode string) bool {
	return mode != "welcome" && isValidMode(mode)
}

func isValidSheetColumnType(t string) bool {
	switch t {
	case "text", "number", "date", "checkbox":
		return true
	}
	return false
}

func isValidChartType(t string) bool {
	switch t {
	case "bar", "line", "area", "pie":
		return true
	}
	return false
}

// POST /api/canvas/pins
func (h *Handler) CreatePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var pin store.Pin
	if err := decode(r, &pin); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if msg := validateLatLng(pin.Lat, pin.Lng); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	pin.ID = uuid.New()
	pin.Kind = "pin"
	if pin.CreatedBy == "" {
		pin.CreatedBy = "agent"
	}
	if _, err := h.store.CreatePin(r.Context(), canvasID, &pin); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, pin)
}

// PATCH /api/canvas/pins/{id}
func (h *Handler) UpdatePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.PinPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Validate any coordinate the patch touches (lat/lng are independently
	// optional in a patch, so check whichever is present, defaulting the other to
	// an in-range value so a single-field update isn't blocked by the absent one).
	if patch.Lat != nil || patch.Lng != nil {
		lat, lng := 0.0, 0.0
		if patch.Lat != nil {
			lat = *patch.Lat
		}
		if patch.Lng != nil {
			lng = *patch.Lng
		}
		if msg := validateLatLng(lat, lng); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
	}
	if _, err := h.store.UpdatePin(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/pins/{id}
func (h *Handler) DeletePin(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if _, err := h.store.DeletePin(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/events
func (h *Handler) CreateEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Title      string      `json:"title"`
		Start      time.Time   `json:"start"`
		End        *time.Time  `json:"end"`
		Timezone   *string     `json:"timezone"`
		PinIDs     []uuid.UUID `json:"pinIds"`
		PinID      *uuid.UUID  `json:"pinId"`
		FromPinID  *uuid.UUID  `json:"fromPinId"`
		ToPinID    *uuid.UUID  `json:"toPinId"`
		TravelMode *string     `json:"travelMode"`
		DayTag     *string     `json:"dayTag"`
		Cost       *float64    `json:"cost"`
		CreatedBy  string      `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	ev := &store.Event{
		ID: uuid.New(), Kind: "event",
		Title: body.Title, Start: body.Start, End: body.End,
		Timezone: body.Timezone,
		PinIDs:   body.PinIDs, PinID: body.PinID,
		FromPinID: body.FromPinID, ToPinID: body.ToPinID,
		TravelMode: body.TravelMode, DayTag: body.DayTag,
		Cost:      body.Cost,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateEvent(r.Context(), canvasID, ev); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, ev)
}

// PATCH /api/canvas/events/{id}
func (h *Handler) UpdateEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.EventPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateEvent(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/events/{id}
func (h *Handler) DeleteEvent(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteEvent(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/notes
func (h *Handler) CreateNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Body       string     `json:"body"`
		ImageRefs  []string   `json:"imageRefs"`
		ParentID   *uuid.UUID `json:"parentId"`
		ParentKind *string    `json:"parentKind"`
		CreatedBy  string     `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	n := &store.Note{
		ID: uuid.New(), Kind: "note",
		Body: body.Body, ImageRefs: body.ImageRefs,
		ParentID: body.ParentID, ParentKind: body.ParentKind,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateNote(r.Context(), canvasID, n); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, n)
}

// PATCH /api/canvas/notes/{id}
func (h *Handler) UpdateNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	var patch store.NotePatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateNote(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/notes/{id}
func (h *Handler) DeleteNote(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteNote(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/roadmap-items
func (h *Handler) CreateRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		ParentID  *uuid.UUID `json:"parentId"`
		Title     string     `json:"title"`
		Body      string     `json:"body"`
		Status    string     `json:"status"`
		Stage     string     `json:"stage"`
		SortOrder int        `json:"sortOrder"`
		CreatedBy string     `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	if body.Status == "" {
		body.Status = "todo"
	}
	item := &store.RoadmapItem{
		ID: uuid.New(), Kind: "roadmap",
		ParentID: body.ParentID, Title: body.Title, Body: body.Body,
		Status: body.Status, Stage: body.Stage, SortOrder: body.SortOrder, CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateRoadmapItem(r.Context(), canvasID, item); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, item)
}

// PATCH /api/canvas/roadmap-items/{id}
func (h *Handler) UpdateRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.RoadmapItemPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateRoadmapItem(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/roadmap-items/{id}
func (h *Handler) DeleteRoadmapItem(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteRoadmapItem(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ── Sheets ────────────────────────────────────────────────────────────────────

// POST /api/canvas/sheets
func (h *Handler) CreateSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Name      string              `json:"name"`
		Columns   []store.SheetColumn `json:"columns"`
		SortOrder int                 `json:"sortOrder"`
		CreatedBy string              `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	if body.Name == "" {
		body.Name = "Untitled sheet"
	}
	cols := make([]store.SheetColumn, 0, len(body.Columns))
	for _, c := range body.Columns {
		if c.Type == "" {
			c.Type = "text"
		}
		if !isValidSheetColumnType(c.Type) {
			writeError(w, http.StatusBadRequest, "invalid column type: "+c.Type)
			return
		}
		if c.ID == "" {
			c.ID = uuid.New().String()
		}
		cols = append(cols, c)
	}
	sh := &store.Sheet{
		ID: uuid.New(), Kind: "sheet",
		Name: body.Name, Columns: cols, SortOrder: body.SortOrder,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateSheet(r.Context(), canvasID, sh); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, sh)
}

// PATCH /api/canvas/sheets/{id}
func (h *Handler) UpdateSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.SheetPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateSheet(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheets/{id}
func (h *Handler) DeleteSheet(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteSheet(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/sheets/{id}/columns
func (h *Handler) AddSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid sheet id")
		return
	}
	var body store.SheetColumn
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Type == "" {
		body.Type = "text"
	}
	if !isValidSheetColumnType(body.Type) {
		writeError(w, http.StatusBadRequest, "invalid column type")
		return
	}
	if body.ID == "" {
		body.ID = uuid.New().String()
	}
	if _, err := h.store.AddSheetColumn(r.Context(), canvasID, sheetID, body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, body)
}

// PATCH /api/canvas/sheets/{id}/columns/{columnId}
func (h *Handler) UpdateSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid sheet id")
		return
	}
	columnID := chi.URLParam(r, "columnId")
	var patch store.SheetColumnPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if patch.Type != nil && !isValidSheetColumnType(*patch.Type) {
		writeError(w, http.StatusBadRequest, "invalid column type")
		return
	}
	if _, err := h.store.UpdateSheetColumn(r.Context(), canvasID, sheetID, columnID, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheets/{id}/columns/{columnId}
func (h *Handler) DeleteSheetColumn(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	sheetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid sheet id")
		return
	}
	columnID := chi.URLParam(r, "columnId")
	if _, err := h.store.DeleteSheetColumn(r.Context(), canvasID, sheetID, columnID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/sheet-rows
func (h *Handler) CreateSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		SheetID   uuid.UUID      `json:"sheetId"`
		Data      map[string]any `json:"data"`
		SortOrder int            `json:"sortOrder"`
		CreatedBy string         `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	if body.Data == nil {
		body.Data = map[string]any{}
	}
	row := &store.SheetRow{
		ID: uuid.New(), Kind: "sheetRow", SheetID: body.SheetID,
		Data: body.Data, SortOrder: body.SortOrder, CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateSheetRow(r.Context(), canvasID, row); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, row)
}

// PATCH /api/canvas/sheet-rows/{id}
func (h *Handler) UpdateSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var patch store.SheetRowPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := h.store.UpdateSheetRow(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/sheet-rows/{id}
func (h *Handler) DeleteSheetRow(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteSheetRow(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// ── Charts ────────────────────────────────────────────────────────────────────

// POST /api/canvas/charts
func (h *Handler) CreateChart(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		Name      string    `json:"name"`
		SheetID   uuid.UUID `json:"sheetId"`
		ChartType string    `json:"chartType"`
		XColumn   string    `json:"xColumn"`
		YColumns  []string  `json:"yColumns"`
		SortOrder int       `json:"sortOrder"`
		CreatedBy string    `json:"createdBy"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.SheetID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "sheetId is required")
		return
	}
	if body.CreatedBy == "" {
		body.CreatedBy = "agent"
	}
	if body.ChartType == "" {
		body.ChartType = "bar"
	}
	if !isValidChartType(body.ChartType) {
		writeError(w, http.StatusBadRequest, "invalid chart type: "+body.ChartType)
		return
	}
	if body.Name == "" {
		body.Name = "Untitled chart"
	}
	if body.YColumns == nil {
		body.YColumns = []string{}
	}
	ch := &store.Chart{
		ID: uuid.New(), Kind: "chart",
		Name: body.Name, SheetID: body.SheetID, ChartType: body.ChartType,
		XColumn: body.XColumn, YColumns: body.YColumns, SortOrder: body.SortOrder,
		CreatedBy: body.CreatedBy,
	}
	if _, err := h.store.CreateChart(r.Context(), canvasID, ch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, ch)
}

// PATCH /api/canvas/charts/{id}
func (h *Handler) UpdateChart(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	var patch store.ChartPatch
	if err := decode(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if patch.ChartType != nil && !isValidChartType(*patch.ChartType) {
		writeError(w, http.StatusBadRequest, "invalid chart type: "+*patch.ChartType)
		return
	}
	if _, err := h.store.UpdateChart(r.Context(), canvasID, id, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// DELETE /api/canvas/charts/{id}
func (h *Handler) DeleteChart(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if _, err := h.store.DeleteChart(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// POST /api/canvas/pending-edits
func (h *Handler) CreatePendingEdit(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	var body struct {
		EntityID    uuid.UUID `json:"entityId"`
		Instruction string    `json:"instruction"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	edit, err := h.store.CreatePendingEdit(r.Context(), canvasID, body.EntityID, body.Instruction)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusCreated, edit)
}

// DELETE /api/canvas/pending-edits/{id}
func (h *Handler) DeletePendingEdit(w http.ResponseWriter, r *http.Request) {
	canvasID := CanvasIDFromCtx(r.Context())
	id, _ := uuid.Parse(chi.URLParam(r, "id"))
	if err := h.store.DeletePendingEdit(r.Context(), canvasID, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	broadcastState(r.Context(), h.store, h.hub, canvasID)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}
