package store

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	supa "github.com/supabase-community/supabase-go"
	"github.com/google/uuid"
)

// Ambiguous glyphs (0/O, 1/I/L) intentionally excluded so codes are easy to
// dictate over voice/chat. Length 8 over this 32-char alphabet → 32^8 ≈ 1.1e12
// keyspace, which is what makes brute-forcing the canvas code (our only auth)
// infeasible — provided the generator is unpredictable. Hence crypto/rand.
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateCode() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is a kernel-level problem; we'd rather refuse
		// to issue a guessable code than silently fall back to math/rand.
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	out := make([]byte, 8)
	for i, x := range b {
		out[i] = codeChars[int(x)%len(codeChars)]
	}
	return string(out)
}

// ── DB row types (snake_case = Supabase column names) ─────────────────────────

type dbCanvas struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Mode      string  `json:"mode"`
	MapID     *string `json:"map_id"`
	Version   int     `json:"version"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type dbPin struct {
	ID        string  `json:"id"`
	PinType   string  `json:"pin_type"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	Label     *string `json:"label"`
	Body      *string `json:"body"`
	Color     *string `json:"color"`
	CreatedBy string  `json:"created_by"`
	UpdatedAt string  `json:"updated_at"`
}

type dbEvent struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	StartTime  string   `json:"start_time"`
	EndTime    *string  `json:"end_time"`
	Timezone   *string  `json:"timezone"`
	PinIDs     []string `json:"pin_ids"`
	PinID      *string  `json:"pin_id"`
	FromPinID  *string  `json:"from_pin_id"`
	ToPinID    *string `json:"to_pin_id"`
	TravelMode *string `json:"travel_mode"`
	DayTag     *string `json:"day_tag"`
	CreatedBy  string  `json:"created_by"`
	UpdatedAt  string  `json:"updated_at"`
}

type dbNote struct {
	ID         string   `json:"id"`
	Body       string   `json:"body"`
	ImageRefs  []string `json:"image_refs"`
	ParentID   *string  `json:"parent_id"`
	ParentKind *string  `json:"parent_kind"`
	CreatedBy  string   `json:"created_by"`
	UpdatedAt  string   `json:"updated_at"`
}

type dbRoadmapItem struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parent_id"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	Status    string  `json:"status"`
	Stage     *string `json:"stage"`
	SortOrder int     `json:"sort_order"`
	CreatedBy string  `json:"created_by"`
	UpdatedAt string  `json:"updated_at"`
}

type dbSheet struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Columns   json.RawMessage `json:"columns"`
	SortOrder int             `json:"sort_order"`
	CreatedBy string          `json:"created_by"`
	UpdatedAt string          `json:"updated_at"`
	// sheet_rows is FK'd to sheets (no canvas_id), so PostgREST embeds rows
	// nested here under each sheet — NOT as a top-level table on the canvas.
	SheetRows []dbSheetRow `json:"sheet_rows"`
}

type dbSheetRow struct {
	ID        string          `json:"id"`
	SheetID   string          `json:"sheet_id"`
	Data      json.RawMessage `json:"data"`
	SortOrder int             `json:"sort_order"`
	CreatedBy string          `json:"created_by"`
	UpdatedAt string          `json:"updated_at"`
}

type dbChart struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	SheetID   string          `json:"sheet_id"`
	ChartType string          `json:"chart_type"`
	XColumn   string          `json:"x_column"`
	YColumns  json.RawMessage `json:"y_columns"`
	SortOrder int             `json:"sort_order"`
	CreatedBy string          `json:"created_by"`
	UpdatedAt string          `json:"updated_at"`
}

type dbAction struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	State        string          `json:"state"`
	Payload      json.RawMessage `json:"payload"`
	ProposedBy   string          `json:"proposed_by"`
	ApprovedBy   *string         `json:"approved_by"`
	Result       *string         `json:"result"`
	Error        *string         `json:"error"`
	LinkedPinIDs json.RawMessage `json:"linked_pin_ids"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
}

type dbAgent struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Role       string  `json:"role"`
	Model      *string `json:"model"`
	Status     string  `json:"status"`
	LastSeenAt string  `json:"last_seen_at"`
}

type dbUser struct {
	ID          string `json:"id"`
	GoogleSub   string `json:"google_sub"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	CreatedAt   string `json:"created_at"`
	LastSeenAt  string `json:"last_seen_at"`
}

type dbPendingEdit struct {
	ID          string `json:"id"`
	EntityID    string `json:"entity_id"`
	Instruction string `json:"instruction"`
	CreatedAt   string `json:"created_at"`
}

// Used for GetCanvasState — one request with embedded child tables.
type dbCanvasWithChildren struct {
	dbCanvas
	Pins          []dbPin          `json:"pins"`
	Events        []dbEvent        `json:"events"`
	Notes         []dbNote         `json:"notes"`
	RoadmapItems  []dbRoadmapItem  `json:"roadmap_items"`
	Sheets        []dbSheet        `json:"sheets"`
	// NOTE: sheet rows are NOT a top-level embed — they ride nested inside each
	// dbSheet.SheetRows (sheet_rows is FK'd to sheets, not canvases).
	Charts        []dbChart        `json:"charts"`
	Actions       []dbAction       `json:"actions"`
	Agents        []dbAgent        `json:"agents"`
	PendingEdits  []dbPendingEdit  `json:"pending_edits"`
}

// ── Converters ────────────────────────────────────────────────────────────────

func uuidStrings(ids []uuid.UUID) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.String())
	}
	return out
}

func parseTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func toCanvas(d dbCanvas) *Canvas {
	id, _ := uuid.Parse(d.ID)
	return &Canvas{ID: id, Code: d.Code, Name: d.Name, Mode: d.Mode, MapID: d.MapID, Version: d.Version,
		CreatedAt: parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt)}
}

func toPin(d dbPin) *Pin {
	id, _ := uuid.Parse(d.ID)
	return &Pin{ID: id, Kind: "pin", PinType: d.PinType, Lat: d.Lat, Lng: d.Lng,
		Label: d.Label, Body: d.Body, Color: d.Color,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
}

func toEvent(d dbEvent) *Event {
	id, _ := uuid.Parse(d.ID)
	ev := &Event{ID: id, Kind: "event", Title: d.Title, Start: parseTime(d.StartTime),
		Timezone:   d.Timezone,
		TravelMode: d.TravelMode,
		DayTag:     d.DayTag,
		CreatedBy:  d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if d.EndTime != nil {
		t := parseTime(*d.EndTime)
		ev.End = &t
	}
	if d.PinID != nil {
		pinID, err := uuid.Parse(*d.PinID)
		if err == nil {
			ev.PinID = &pinID
		}
	}
	for _, s := range d.PinIDs {
		if id, err := uuid.Parse(s); err == nil {
			ev.PinIDs = append(ev.PinIDs, id)
		}
	}
	// Canonicalize: legacy single-pin events have pin_id but no pin_ids — surface
	// them through pinIds too so readers only need to look at one field.
	if len(ev.PinIDs) == 0 && ev.PinID != nil {
		ev.PinIDs = []uuid.UUID{*ev.PinID}
	}
	if d.FromPinID != nil {
		pinID, err := uuid.Parse(*d.FromPinID)
		if err == nil {
			ev.FromPinID = &pinID
		}
	}
	if d.ToPinID != nil {
		pinID, err := uuid.Parse(*d.ToPinID)
		if err == nil {
			ev.ToPinID = &pinID
		}
	}
	return ev
}

func toNote(d dbNote) *Note {
	id, _ := uuid.Parse(d.ID)
	n := &Note{ID: id, Kind: "note", Body: d.Body,
		ImageRefs: d.ImageRefs, ParentKind: d.ParentKind,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if n.ImageRefs == nil {
		n.ImageRefs = []string{}
	}
	if d.ParentID != nil {
		parentID, err := uuid.Parse(*d.ParentID)
		if err == nil {
			n.ParentID = &parentID
		}
	}
	return n
}

func toRoadmapItem(d dbRoadmapItem) *RoadmapItem {
	id, _ := uuid.Parse(d.ID)
	r := &RoadmapItem{ID: id, Kind: "roadmap",
		Title: d.Title, Body: d.Body, Status: d.Status, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if d.Stage != nil {
		r.Stage = *d.Stage
	}
	if d.ParentID != nil {
		parentID, err := uuid.Parse(*d.ParentID)
		if err == nil {
			r.ParentID = &parentID
		}
	}
	return r
}

func toSheet(d dbSheet) *Sheet {
	id, _ := uuid.Parse(d.ID)
	s := &Sheet{ID: id, Kind: "sheet",
		Name: d.Name, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Columns: []SheetColumn{},
	}
	if len(d.Columns) > 0 {
		_ = json.Unmarshal(d.Columns, &s.Columns)
	}
	return s
}

func toChart(d dbChart) *Chart {
	id, _ := uuid.Parse(d.ID)
	sheetID, _ := uuid.Parse(d.SheetID)
	c := &Chart{ID: id, Kind: "chart",
		Name: d.Name, SheetID: sheetID, ChartType: d.ChartType,
		XColumn: d.XColumn, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		YColumns: []string{},
	}
	if len(d.YColumns) > 0 {
		_ = json.Unmarshal(d.YColumns, &c.YColumns)
	}
	return c
}

func toAction(d dbAction) *Action {
	id, _ := uuid.Parse(d.ID)
	a := &Action{ID: id, Kind: "action",
		Type: d.Type, State: d.State,
		Payload:    d.Payload,
		ProposedBy: d.ProposedBy, ApprovedBy: d.ApprovedBy,
		Result: d.Result, Error: d.Error,
		LinkedPinIDs: []uuid.UUID{},
		CreatedAt:    parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt),
	}
	if len(a.Payload) == 0 {
		a.Payload = json.RawMessage("{}")
	}
	if len(d.LinkedPinIDs) > 0 {
		var ids []string
		if err := json.Unmarshal(d.LinkedPinIDs, &ids); err == nil {
			for _, s := range ids {
				if pid, err := uuid.Parse(s); err == nil {
					a.LinkedPinIDs = append(a.LinkedPinIDs, pid)
				}
			}
		}
	}
	return a
}

func toAgent(d dbAgent) *Agent {
	id, _ := uuid.Parse(d.ID)
	return &Agent{ID: id, Kind: "agent",
		Name: d.Name, Role: d.Role, Model: d.Model, Status: d.Status,
		LastSeenAt: parseTime(d.LastSeenAt)}
}

func toSheetRow(d dbSheetRow) *SheetRow {
	id, _ := uuid.Parse(d.ID)
	sheetID, _ := uuid.Parse(d.SheetID)
	r := &SheetRow{ID: id, Kind: "sheetRow", SheetID: sheetID,
		SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Data: map[string]any{},
	}
	if len(d.Data) > 0 {
		_ = json.Unmarshal(d.Data, &r.Data)
	}
	return r
}

func toUser(d dbUser) *User {
	id, _ := uuid.Parse(d.ID)
	return &User{
		ID: id, GoogleSub: d.GoogleSub, Email: d.Email,
		DisplayName: d.DisplayName, AvatarURL: d.AvatarURL,
		CreatedAt: parseTime(d.CreatedAt), LastSeenAt: parseTime(d.LastSeenAt),
	}
}

func toPendingEdit(d dbPendingEdit) *PendingEdit {
	id, _ := uuid.Parse(d.ID)
	entityID, _ := uuid.Parse(d.EntityID)
	return &PendingEdit{ID: id, EntityID: entityID,
		Instruction: d.Instruction, CreatedAt: parseTime(d.CreatedAt)}
}

// ── Store ─────────────────────────────────────────────────────────────────────

type supabaseStore struct {
	client *supa.Client
}

func NewSupabase(projectURL, apiKey string) (Store, error) {
	client, err := supa.NewClient(projectURL, apiKey, nil)
	if err != nil {
		return nil, fmt.Errorf("supabase client: %w", err)
	}
	return &supabaseStore{client: client}, nil
}

func (s *supabaseStore) Close() {}

// isRpcError detects a PostgREST error JSON in an Rpc() string result.
// This version of supabase-go doesn't return errors from Rpc — they come
// through as JSON objects with a "code" field.
func isRpcError(result string) bool {
	t := strings.TrimSpace(result)
	return strings.HasPrefix(t, "{") && strings.Contains(t, `"code"`)
}

func (s *supabaseStore) bumpVersion(_ context.Context, canvasID uuid.UUID) (int, error) {
	result := s.client.Rpc("bump_canvas_version", "", map[string]string{
		"canvas_id": canvasID.String(),
	})
	if result == "" {
		return 0, fmt.Errorf("bumpVersion: empty response — verify migration 0003 is applied")
	}
	if isRpcError(result) {
		return 0, fmt.Errorf("bumpVersion RPC error: %s", result)
	}
	var v int
	if err := json.Unmarshal([]byte(result), &v); err != nil {
		return 0, fmt.Errorf("bumpVersion parse: %w (response: %s)", err, result)
	}
	return v, nil
}

// exec is a convenience wrapper for mutations that don't need the response body.
func (s *supabaseStore) exec(b interface{ Execute() ([]byte, int64, error) }) error {
	_, _, err := b.Execute()
	return err
}

// ── Canvas ────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateCanvas(_ context.Context, name string) (*Canvas, error) {
	for range 10 {
		code := generateCode()
		var rows []dbCanvas
		_, err := s.client.From("canvases").
			Insert(map[string]string{"code": code, "name": name}, false, "", "representation", "").
			ExecuteTo(&rows)
		if err != nil {
			if strings.Contains(err.Error(), "23505") {
				continue
			}
			return nil, err
		}
		if len(rows) == 0 {
			return nil, fmt.Errorf("no row returned after canvas insert")
		}
		return toCanvas(rows[0]), nil
	}
	return nil, fmt.Errorf("failed to generate unique canvas code after 10 attempts")
}

func (s *supabaseStore) GetCanvasByCode(_ context.Context, code string) (*Canvas, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("code", strings.ToUpper(code)).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("canvas not found: %s", code)
	}
	return toCanvas(rows[0]), nil
}

func (s *supabaseStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*Canvas, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("canvas not found: %s", id)
	}
	return toCanvas(rows[0]), nil
}

// GetCanvasState uses PostgREST embedded selects — one HTTP request for everything.
func (s *supabaseStore) GetCanvasState(_ context.Context, canvasID uuid.UUID) (*Canvas, *CanvasState, []*PendingEdit, error) {
	var rows []dbCanvasWithChildren

	_, err := s.client.From("canvases").
		Select("*,pins(*),events(*),notes(*),roadmap_items(*),sheets(*, sheet_rows(*)),charts(*),actions(*),agents(*),pending_edits(*)", "", false).
		Eq("id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("GetCanvasState: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil, nil, fmt.Errorf("canvas not found: %s", canvasID)
	}

	row := rows[0]
	canvas := toCanvas(row.dbCanvas)

	state := &CanvasState{
		Version:      canvas.Version,
		Mode:         canvas.Mode,
		Pins:         make(map[string]*Pin, len(row.Pins)),
		Events:       make(map[string]*Event, len(row.Events)),
		Notes:        make(map[string]*Note, len(row.Notes)),
		RoadmapItems: make(map[string]*RoadmapItem, len(row.RoadmapItems)),
		Sheets:       make(map[string]*Sheet, len(row.Sheets)),
		SheetRows:    make(map[string]*SheetRow),
		Charts:       make(map[string]*Chart, len(row.Charts)),
		Actions:      make(map[string]*Action, len(row.Actions)),
		Agents:       make(map[string]*Agent, len(row.Agents)),
	}
	for _, d := range row.Pins {
		p := toPin(d)
		state.Pins[p.ID.String()] = p
	}
	for _, d := range row.Events {
		e := toEvent(d)
		state.Events[e.ID.String()] = e
	}
	for _, d := range row.Notes {
		n := toNote(d)
		state.Notes[n.ID.String()] = n
	}
	for _, d := range row.RoadmapItems {
		r := toRoadmapItem(d)
		state.RoadmapItems[r.ID.String()] = r
	}
	for _, d := range row.Sheets {
		sh := toSheet(d)
		state.Sheets[sh.ID.String()] = sh
		// Rows arrive nested under their sheet (see dbSheet.SheetRows); flatten
		// them into the canvas-level SheetRows map the frontend expects.
		for _, rd := range d.SheetRows {
			sr := toSheetRow(rd)
			state.SheetRows[sr.ID.String()] = sr
		}
	}
	for _, d := range row.Charts {
		ch := toChart(d)
		state.Charts[ch.ID.String()] = ch
	}
	for _, d := range row.Actions {
		a := toAction(d)
		state.Actions[a.ID.String()] = a
	}
	for _, d := range row.Agents {
		ag := toAgent(d)
		state.Agents[ag.ID.String()] = ag
	}

	edits := make([]*PendingEdit, 0, len(row.PendingEdits))
	for _, d := range row.PendingEdits {
		edits = append(edits, toPendingEdit(d))
	}
	return canvas, state, edits, nil
}

func (s *supabaseStore) SetMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"mode": mode}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) SetMapID(ctx context.Context, canvasID uuid.UUID, mapID string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"map_id": mapID}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ApplyTemplate(ctx context.Context, canvasID uuid.UUID, mode string, mapID *string) (int, error) {
	update := map[string]any{"mode": mode}
	if mapID != nil {
		update["map_id"] = *mapID
	}
	err := s.exec(s.client.From("canvases").
		Update(update, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// LeaveWelcomeIfNeeded transitions a canvas out of `welcome` mode after an entity
// write (pin/event/note). Idempotent — no-op if the canvas is already in a non-welcome
// mode. fallbackMode is the mode to transition to (typically map/itinerary/docs based
// on which entity was written).
func (s *supabaseStore) LeaveWelcomeIfNeeded(ctx context.Context, canvasID uuid.UUID, fallbackMode string) error {
	c, err := s.GetCanvasByID(ctx, canvasID)
	if err != nil {
		return err
	}
	if c.Mode != "welcome" {
		return nil
	}
	update := map[string]any{"mode": fallbackMode}
	// If transitioning to map and no preset yet chosen, drop a sensible default
	if fallbackMode == "map" && c.MapID == nil {
		update["map_id"] = "world"
	}
	err = s.exec(s.client.From("canvases").
		Update(update, "minimal", "").
		Eq("id", canvasID.String()).
		Eq("mode", "welcome"))
	return err
}

// ── Pins ──────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreatePin(ctx context.Context, canvasID uuid.UUID, pin *Pin) (int, error) {
	now := time.Now().UTC()
	pin.UpdatedAt = now
	row := map[string]any{
		"id": pin.ID.String(), "canvas_id": canvasID.String(),
		"pin_type": pin.PinType, "lat": pin.Lat, "lng": pin.Lng,
		"label": pin.Label, "body": pin.Body, "color": pin.Color,
		"created_by": pin.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	err := s.exec(s.client.From("pins").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "map")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdatePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch PinPatch) (int, error) {
	m := map[string]any{}
	if patch.PinType != nil { m["pin_type"] = *patch.PinType }
	if patch.Lat != nil     { m["lat"] = *patch.Lat }
	if patch.Lng != nil     { m["lng"] = *patch.Lng }
	if patch.Label != nil   { m["label"] = *patch.Label }
	if patch.Body != nil    { m["body"] = *patch.Body }
	if patch.Color != nil   { m["color"] = *patch.Color }
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("pins").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeletePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("pins").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Events ────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateEvent(ctx context.Context, canvasID uuid.UUID, ev *Event) (int, error) {
	now := time.Now().UTC()
	ev.UpdatedAt = now
	// Canonicalize the pin list: prefer PinIDs, fall back to a single PinID.
	if len(ev.PinIDs) == 0 && ev.PinID != nil {
		ev.PinIDs = []uuid.UUID{*ev.PinID}
	}
	row := map[string]any{
		"id": ev.ID.String(), "canvas_id": canvasID.String(),
		"title": ev.Title, "start_time": ev.Start.Format(time.RFC3339),
		"pin_ids":    uuidStrings(ev.PinIDs),
		"created_by": ev.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if ev.End != nil {
		row["end_time"] = ev.End.Format(time.RFC3339)
	}
	if ev.Timezone != nil {
		row["timezone"] = *ev.Timezone
	}
	if ev.PinID != nil {
		row["pin_id"] = ev.PinID.String()
	}
	if ev.FromPinID != nil {
		row["from_pin_id"] = ev.FromPinID.String()
	}
	if ev.ToPinID != nil {
		row["to_pin_id"] = ev.ToPinID.String()
	}
	if ev.TravelMode != nil {
		row["travel_mode"] = *ev.TravelMode
	}
	if ev.DayTag != nil {
		row["day_tag"] = *ev.DayTag
	}
	err := s.exec(s.client.From("events").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "itinerary")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch EventPatch) (int, error) {
	m := map[string]any{}
	if patch.Title != nil      { m["title"] = *patch.Title }
	if patch.Start != nil      { m["start_time"] = patch.Start.Format(time.RFC3339) }
	if patch.End != nil        { m["end_time"] = patch.End.Format(time.RFC3339) }
	if patch.Timezone != nil   { m["timezone"] = *patch.Timezone }
	if patch.PinIDs != nil     { m["pin_ids"] = uuidStrings(*patch.PinIDs) }
	if patch.PinID != nil      { m["pin_id"] = patch.PinID.String() }
	if patch.FromPinID != nil  { m["from_pin_id"] = patch.FromPinID.String() }
	if patch.ToPinID != nil    { m["to_pin_id"] = patch.ToPinID.String() }
	if patch.TravelMode != nil { m["travel_mode"] = *patch.TravelMode }
	if patch.DayTag != nil     { m["day_tag"] = *patch.DayTag }
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("events").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("events").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateNote(ctx context.Context, canvasID uuid.UUID, n *Note) (int, error) {
	now := time.Now().UTC()
	n.UpdatedAt = now
	refs := n.ImageRefs
	if refs == nil {
		refs = []string{}
	}
	row := map[string]any{
		"id": n.ID.String(), "canvas_id": canvasID.String(),
		"body": n.Body, "image_refs": refs,
		"parent_kind": n.ParentKind, "created_by": n.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if n.ParentID != nil {
		row["parent_id"] = n.ParentID.String()
	}
	err := s.exec(s.client.From("notes").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "docs")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch NotePatch) (int, error) {
	m := map[string]any{}
	if patch.Body != nil       { m["body"] = *patch.Body }
	if patch.ImageRefs != nil  { m["image_refs"] = patch.ImageRefs }
	if patch.ParentKind != nil { m["parent_kind"] = *patch.ParentKind }
	if patch.ParentID != nil   { m["parent_id"] = patch.ParentID.String() }
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("notes").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("notes").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Roadmap items ─────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateRoadmapItem(ctx context.Context, canvasID uuid.UUID, r *RoadmapItem) (int, error) {
	now := time.Now().UTC()
	r.UpdatedAt = now
	row := map[string]any{
		"id": r.ID.String(), "canvas_id": canvasID.String(),
		"title": r.Title, "body": r.Body,
		"status": r.Status, "sort_order": r.SortOrder,
		"created_by": r.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if r.ParentID != nil {
		row["parent_id"] = r.ParentID.String()
	}
	if r.Stage != "" {
		row["stage"] = r.Stage
	}
	err := s.exec(s.client.From("roadmap_items").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "roadmap")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch RoadmapItemPatch) (int, error) {
	m := map[string]any{}
	if patch.Title != nil     { m["title"] = *patch.Title }
	if patch.Body != nil      { m["body"] = *patch.Body }
	if patch.Status != nil    { m["status"] = *patch.Status }
	if patch.SortOrder != nil { m["sort_order"] = *patch.SortOrder }
	if patch.ParentID != nil  { m["parent_id"] = patch.ParentID.String() }
	// Stage: "" clears the phase (store NULL), a label sets it.
	if patch.Stage != nil {
		if *patch.Stage == "" {
			m["stage"] = nil
		} else {
			m["stage"] = *patch.Stage
		}
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("roadmap_items").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("roadmap_items").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ReorderRoadmapItems applies a batch of (parent_id, sort_order) updates and
// bumps version once. The frontend builds the batch from a single drag-and-drop
// gesture, so we avoid N broadcasts. Not transactional — a partial failure
// leaves the tree in a valid (but unintended) state; the next state read
// reconciles.
func (s *supabaseStore) ReorderRoadmapItems(ctx context.Context, canvasID uuid.UUID, updates []RoadmapReorder) (int, error) {
	for _, u := range updates {
		m := map[string]any{"sort_order": u.SortOrder}
		if u.ParentID != nil {
			m["parent_id"] = u.ParentID.String()
		} else {
			m["parent_id"] = nil
		}
		err := s.exec(s.client.From("roadmap_items").
			Update(m, "minimal", "").
			Eq("id", u.ID.String()).
			Eq("canvas_id", canvasID.String()))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Agents (v1 identity / provenance) ─────────────────────────────────────────

func (s *supabaseStore) RegisterAgent(ctx context.Context, canvasID uuid.UUID, a *Agent) (int, error) {
	now := time.Now().UTC()
	a.LastSeenAt = now
	a.Status = "online"
	row := map[string]any{
		"id": a.ID.String(), "canvas_id": canvasID.String(),
		"name": a.Name, "role": a.Role, "status": "online",
		"last_seen_at": now.Format(time.RFC3339),
	}
	if a.Model != nil {
		row["model"] = *a.Model
	}
	if err := s.exec(s.client.From("agents").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Actions (v1 execution primitive) ──────────────────────────────────────────

func (s *supabaseStore) CreateAction(ctx context.Context, canvasID uuid.UUID, a *Action) (int, error) {
	now := time.Now().UTC()
	a.CreatedAt, a.UpdatedAt = now, now
	if len(a.Payload) == 0 {
		a.Payload = json.RawMessage("{}")
	}
	linkedJSON, err := json.Marshal(uuidStrings(a.LinkedPinIDs))
	if err != nil {
		return 0, err
	}
	row := map[string]any{
		"id": a.ID.String(), "canvas_id": canvasID.String(),
		"type": a.Type, "state": a.State,
		"payload":        json.RawMessage(a.Payload),
		"proposed_by":    a.ProposedBy,
		"linked_pin_ids": json.RawMessage(linkedJSON),
		"updated_at":     now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("actions").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) GetAction(_ context.Context, canvasID, id uuid.UUID) (*Action, error) {
	var rows []dbAction
	_, err := s.client.From("actions").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("action %s not found in canvas %s", id, canvasID)
	}
	return toAction(rows[0]), nil
}

func (s *supabaseStore) ListActions(_ context.Context, canvasID uuid.UUID, stateFilter string) ([]*Action, error) {
	var rows []dbAction
	q := s.client.From("actions").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String())
	if stateFilter != "" {
		q = q.Eq("state", stateFilter)
	}
	if _, err := q.Order("created_at", nil).ExecuteTo(&rows); err != nil {
		return nil, err
	}
	out := make([]*Action, 0, len(rows))
	for _, d := range rows {
		out = append(out, toAction(d))
	}
	return out, nil
}

// UpdateActionState applies a single transition. The caller (handler) is
// responsible for validating the transition is legal; this just writes the
// fields the target state carries.
func (s *supabaseStore) UpdateActionState(ctx context.Context, canvasID, id uuid.UUID, patch ActionStatePatch) (int, error) {
	m := map[string]any{"state": patch.State}
	if patch.Result != nil     { m["result"] = *patch.Result }
	if patch.Error != nil      { m["error"] = *patch.Error }
	if patch.ApprovedBy != nil { m["approved_by"] = *patch.ApprovedBy }
	if len(patch.Payload) > 0  { m["payload"] = json.RawMessage(patch.Payload) }
	err := s.exec(s.client.From("actions").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Sheets ────────────────────────────────────────────────────────────────────

// sheetBelongsToCanvas verifies a sheet's canvas_id before allowing column/row
// mutations against it. PostgREST won't filter through embedded selects, so we
// must check explicitly to prevent cross-canvas writes.
func (s *supabaseStore) sheetBelongsToCanvas(canvasID, sheetID uuid.UUID) error {
	var rows []dbSheet
	_, err := s.client.From("sheets").
		Select("id", "", false).
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("sheet %s not found in canvas %s", sheetID, canvasID)
	}
	return nil
}

func (s *supabaseStore) getSheet(canvasID, sheetID uuid.UUID) (*Sheet, error) {
	var rows []dbSheet
	_, err := s.client.From("sheets").
		Select("*", "", false).
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("sheet %s not found in canvas %s", sheetID, canvasID)
	}
	return toSheet(rows[0]), nil
}

func (s *supabaseStore) CreateSheet(ctx context.Context, canvasID uuid.UUID, sh *Sheet) (int, error) {
	cols := sh.Columns
	if cols == nil {
		cols = []SheetColumn{}
	}
	colsJSON, err := json.Marshal(cols)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	sh.UpdatedAt = now
	row := map[string]any{
		"id":          sh.ID.String(),
		"canvas_id":   canvasID.String(),
		"name":        sh.Name,
		"columns":     json.RawMessage(colsJSON),
		"sort_order":  sh.SortOrder,
		"created_by":  sh.CreatedBy,
		"updated_at":  now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("sheets").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "sheets")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil      { m["name"] = *patch.Name }
	if patch.SortOrder != nil { m["sort_order"] = *patch.SortOrder }
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("sheets").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("sheets").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) AddSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, col SheetColumn) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	if col.ID == "" {
		col.ID = uuid.New().String()
	}
	sh.Columns = append(sh.Columns, col)
	return s.writeSheetColumns(ctx, canvasID, sheetID, sh.Columns)
}

func (s *supabaseStore) UpdateSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string, patch SheetColumnPatch) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	found := false
	for i := range sh.Columns {
		if sh.Columns[i].ID == columnID {
			if patch.Name != nil      { sh.Columns[i].Name = *patch.Name }
			if patch.Type != nil      { sh.Columns[i].Type = *patch.Type }
			if patch.SortOrder != nil { sh.Columns[i].SortOrder = *patch.SortOrder }
			found = true
			break
		}
	}
	if !found {
		return 0, fmt.Errorf("column %s not found in sheet %s", columnID, sheetID)
	}
	return s.writeSheetColumns(ctx, canvasID, sheetID, sh.Columns)
}

// DeleteSheetColumn removes the column from the sheet's columns JSONB AND strips
// the same key from every row's data JSONB. Two writes per affected row.
func (s *supabaseStore) DeleteSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	filtered := make([]SheetColumn, 0, len(sh.Columns))
	for _, c := range sh.Columns {
		if c.ID != columnID {
			filtered = append(filtered, c)
		}
	}
	if _, err := s.writeSheetColumns(ctx, canvasID, sheetID, filtered); err != nil {
		return 0, err
	}
	// Strip the column from each row's JSONB. Cheap-and-clear approach: fetch
	// all rows for this sheet, mutate, write back. For sheets with <10k rows
	// this is fine; if a sheet outgrows that we'd switch to a Postgres function.
	var rows []dbSheetRow
	_, err = s.client.From("sheet_rows").
		Select("*", "", false).
		Eq("sheet_id", sheetID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		var data map[string]any
		_ = json.Unmarshal(r.Data, &data)
		if _, ok := data[columnID]; !ok {
			continue
		}
		delete(data, columnID)
		newJSON, _ := json.Marshal(data)
		err := s.exec(s.client.From("sheet_rows").
			Update(map[string]any{"data": json.RawMessage(newJSON)}, "minimal", "").
			Eq("id", r.ID))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) writeSheetColumns(ctx context.Context, canvasID, sheetID uuid.UUID, cols []SheetColumn) (int, error) {
	colsJSON, err := json.Marshal(cols)
	if err != nil {
		return 0, err
	}
	err = s.exec(s.client.From("sheets").
		Update(map[string]any{"columns": json.RawMessage(colsJSON)}, "minimal", "").
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// resolveRowData remaps human-friendly column-name keys in row data to the
// canonical column.id keys storage uses (the JSONB is keyed by id so renames
// stay free — see migration 0007). Keys already matching a column id pass
// through; keys matching a column name (case-insensitive) are rewritten to that
// column's id; anything unrecognized is left untouched. This lets agents write
// rows keyed by column name without first looking up the column uuids.
func resolveRowData(cols []SheetColumn, data map[string]any) map[string]any {
	if len(data) == 0 || len(cols) == 0 {
		return data
	}
	ids := make(map[string]bool, len(cols))
	byName := make(map[string]string, len(cols))
	for _, c := range cols {
		ids[c.ID] = true
		byName[strings.ToLower(strings.TrimSpace(c.Name))] = c.ID
	}
	out := make(map[string]any, len(data))
	for k, v := range data {
		if ids[k] {
			out[k] = v
		} else if id, ok := byName[strings.ToLower(strings.TrimSpace(k))]; ok {
			out[id] = v
		} else {
			out[k] = v
		}
	}
	return out
}

func (s *supabaseStore) CreateSheetRow(ctx context.Context, canvasID uuid.UUID, r *SheetRow) (int, error) {
	// getSheet both scope-checks the sheet against the canvas and gives us the
	// column schema needed to resolve name-keyed cell data.
	sh, err := s.getSheet(canvasID, r.SheetID)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	r.UpdatedAt = now
	data := resolveRowData(sh.Columns, r.Data)
	if data == nil {
		data = map[string]any{}
	}
	r.Data = data
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	row := map[string]any{
		"id":         r.ID.String(),
		"sheet_id":   r.SheetID.String(),
		"data":       json.RawMessage(dataJSON),
		"sort_order": r.SortOrder,
		"created_by": r.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("sheet_rows").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// UpdateSheetRow merges patch.Data into the existing row data (rather than
// replacing wholesale) so partial cell updates don't clobber other cells.
func (s *supabaseStore) UpdateSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetRowPatch) (int, error) {
	if patch.Data == nil && patch.SortOrder == nil {
		return 0, nil
	}
	// Fetch existing row to scope by canvas and to merge data.
	var rows []dbSheetRow
	_, err := s.client.From("sheet_rows").
		Select("*,sheets!inner(canvas_id)", "", false).
		Eq("id", id.String()).
		Eq("sheets.canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("sheet row %s not found in canvas %s", id, canvasID)
	}
	m := map[string]any{}
	if patch.Data != nil {
		// Resolve name-keyed cells to column ids before merging (best-effort:
		// if the sheet lookup fails we merge the keys as given).
		if sheetID, perr := uuid.Parse(rows[0].SheetID); perr == nil {
			if sh, serr := s.getSheet(canvasID, sheetID); serr == nil {
				patch.Data = resolveRowData(sh.Columns, patch.Data)
			}
		}
		var existing map[string]any
		_ = json.Unmarshal(rows[0].Data, &existing)
		if existing == nil {
			existing = map[string]any{}
		}
		for k, v := range patch.Data {
			if v == nil {
				delete(existing, k)
			} else {
				existing[k] = v
			}
		}
		merged, _ := json.Marshal(existing)
		m["data"] = json.RawMessage(merged)
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	err = s.exec(s.client.From("sheet_rows").
		Update(m, "minimal", "").
		Eq("id", id.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	// Scope-check: use embedded join filter to ensure the row's sheet belongs to canvas.
	var rows []dbSheetRow
	_, err := s.client.From("sheet_rows").
		Select("id,sheets!inner(canvas_id)", "", false).
		Eq("id", id.String()).
		Eq("sheets.canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("sheet row %s not found in canvas %s", id, canvasID)
	}
	err = s.exec(s.client.From("sheet_rows").
		Delete("minimal", "").
		Eq("id", id.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ReorderSheetRows(ctx context.Context, canvasID, sheetID uuid.UUID, updates []SheetRowReorder) (int, error) {
	if err := s.sheetBelongsToCanvas(canvasID, sheetID); err != nil {
		return 0, err
	}
	for _, u := range updates {
		err := s.exec(s.client.From("sheet_rows").
			Update(map[string]any{"sort_order": u.SortOrder}, "minimal", "").
			Eq("id", u.ID.String()).
			Eq("sheet_id", sheetID.String()))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Charts ────────────────────────────────────────────────────────────────────

func (s *supabaseStore) getChart(canvasID, id uuid.UUID) (*Chart, error) {
	var rows []dbChart
	_, err := s.client.From("charts").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("chart %s not found in canvas %s", id, canvasID)
	}
	return toChart(rows[0]), nil
}

// resolveChartCols maps human-readable column NAMES to SheetColumn ids so agents
// can pass either. An exact id match wins; otherwise a case-insensitive name
// match; otherwise the ref is left as-is. Empty x is passed through (used by
// UpdateChart when only y columns change).
func (s *supabaseStore) resolveChartCols(canvasID, sheetID uuid.UUID, x string, ys []string) (string, []string) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return x, ys
	}
	resolve := func(ref string) string {
		ref = strings.TrimSpace(ref)
		for _, c := range sh.Columns {
			if c.ID == ref {
				return ref
			}
		}
		for _, c := range sh.Columns {
			if strings.EqualFold(strings.TrimSpace(c.Name), ref) {
				return c.ID
			}
		}
		return ref
	}
	rx := x
	if x != "" {
		rx = resolve(x)
	}
	rys := make([]string, 0, len(ys))
	for _, y := range ys {
		if strings.TrimSpace(y) != "" {
			rys = append(rys, resolve(y))
		}
	}
	return rx, rys
}

func (s *supabaseStore) CreateChart(ctx context.Context, canvasID uuid.UUID, ch *Chart) (int, error) {
	if err := s.sheetBelongsToCanvas(canvasID, ch.SheetID); err != nil {
		return 0, err
	}
	ch.XColumn, ch.YColumns = s.resolveChartCols(canvasID, ch.SheetID, ch.XColumn, ch.YColumns)
	if ch.YColumns == nil {
		ch.YColumns = []string{}
	}
	ysJSON, err := json.Marshal(ch.YColumns)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	ch.UpdatedAt = now
	row := map[string]any{
		"id":         ch.ID.String(),
		"canvas_id":  canvasID.String(),
		"sheet_id":   ch.SheetID.String(),
		"name":       ch.Name,
		"chart_type": ch.ChartType,
		"x_column":   ch.XColumn,
		"y_columns":  json.RawMessage(ysJSON),
		"sort_order": ch.SortOrder,
		"created_by": ch.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("charts").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "charts")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch ChartPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil {
		m["name"] = *patch.Name
	}
	if patch.ChartType != nil {
		m["chart_type"] = *patch.ChartType
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}

	// Column refs are resolved against the chart's (possibly new) sheet.
	if patch.XColumn != nil || patch.YColumns != nil || patch.SheetID != nil {
		var sheetID uuid.UUID
		if patch.SheetID != nil {
			sheetID = *patch.SheetID
			if err := s.sheetBelongsToCanvas(canvasID, sheetID); err != nil {
				return 0, err
			}
			m["sheet_id"] = sheetID.String()
		} else {
			cur, err := s.getChart(canvasID, id)
			if err != nil {
				return 0, err
			}
			sheetID = cur.SheetID
		}
		if patch.XColumn != nil {
			x, _ := s.resolveChartCols(canvasID, sheetID, *patch.XColumn, nil)
			m["x_column"] = x
		}
		if patch.YColumns != nil {
			_, ys := s.resolveChartCols(canvasID, sheetID, "", *patch.YColumns)
			if ys == nil {
				ys = []string{}
			}
			yj, err := json.Marshal(ys)
			if err != nil {
				return 0, err
			}
			m["y_columns"] = json.RawMessage(yj)
		}
	}

	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("charts").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("charts").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Users ─────────────────────────────────────────────────────────────────────

// UpsertUserByGoogleSub inserts a user or, on google_sub conflict, refreshes
// their profile fields + last_seen_at. Returns the resulting row. We never pass
// `id` so the PK default fills on insert and the existing id is preserved on
// conflict.
func (s *supabaseStore) UpsertUserByGoogleSub(_ context.Context, u *User) (*User, error) {
	row := map[string]any{
		"google_sub":   u.GoogleSub,
		"email":        u.Email,
		"display_name": u.DisplayName,
		"avatar_url":   u.AvatarURL,
		"last_seen_at": time.Now().UTC().Format(time.RFC3339),
	}
	var rows []dbUser
	_, err := s.client.From("users").
		Insert(row, true, "google_sub", "representation", "").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no row returned after user upsert")
	}
	return toUser(rows[0]), nil
}

func (s *supabaseStore) GetUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	var rows []dbUser
	_, err := s.client.From("users").
		Select("*", "", false).
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("user not found: %s", id)
	}
	return toUser(rows[0]), nil
}

// ── Pending edits ─────────────────────────────────────────────────────────────

func (s *supabaseStore) CreatePendingEdit(_ context.Context, canvasID, entityID uuid.UUID, instruction string) (*PendingEdit, error) {
	var rows []dbPendingEdit
	_, err := s.client.From("pending_edits").
		Insert(map[string]string{
			"canvas_id":   canvasID.String(),
			"entity_id":   entityID.String(),
			"instruction": instruction,
		}, false, "", "representation", "").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no row returned after pending_edit insert")
	}
	return toPendingEdit(rows[0]), nil
}

func (s *supabaseStore) DeletePendingEdit(_ context.Context, canvasID, id uuid.UUID) error {
	return s.exec(s.client.From("pending_edits").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
}

func (s *supabaseStore) ListPendingEdits(_ context.Context, canvasID uuid.UUID) ([]*PendingEdit, error) {
	var rows []dbPendingEdit
	_, err := s.client.From("pending_edits").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	edits := make([]*PendingEdit, 0, len(rows))
	for _, d := range rows {
		edits = append(edits, toPendingEdit(d))
	}
	return edits, nil
}
