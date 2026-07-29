package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// errOpSkipped is a sentinel applyOp returns for a malformed/no-op sub-message
// (bad JSON, missing id, invalid enum, empty update list, ...). It's not a
// mutation failure — the caller does not log it again (any diagnostic
// log.Printf already fired inline in the switch below), and it never
// triggers a broadcast on its own. Distinguishing it from a real store error
// lets a "batch" op skip one bad sub-op without silencing genuine mutation
// errors for the others.
var errOpSkipped = errors.New("ws: op skipped")

// WSHandler handles WebSocket upgrades for browser clients.
type WSHandler struct {
	store   store.Store
	hub     *ws.Hub
	authSvc *auth.Service
	maps    *maps.Registry
}

func NewWSHandler(s store.Store, hub *ws.Hub, authSvc *auth.Service, mapsReg *maps.Registry) *WSHandler {
	return &WSHandler{store: s, hub: hub, authSvc: authSvc, maps: mapsReg}
}

// GET /ws?code=CANVAS_CODE
func (wh *WSHandler) ServeWS(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(r.URL.Query().Get("code"))
	if code == "" {
		writeError(w, http.StatusBadRequest, "code query parameter required")
		return
	}

	canvas, err := wh.store.GetCanvasByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusNotFound, "canvas not found")
		return
	}

	// Resolve the connecting human's role from the session cookie (anonymous →
	// nil → public canvases only). This MUST happen before the upgrade so we can
	// still write an HTTP error: once upgraded we can only close the socket.
	var uid *uuid.UUID
	if id, ok := sessionUserID(wh.authSvc, r); ok {
		uid = &id
	}
	role, err := wh.store.ResolveCanvasRole(r.Context(), canvas, uid)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not resolve canvas access")
		return
	}
	if role == "none" {
		writeError(w, http.StatusForbidden, "this canvas is private — sign in with an account it's shared with")
		return
	}
	canWrite := role == "write"

	conn, err := ws.Upgrade(w, r)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	canvasID := canvas.ID
	// Read-only viewers still connect and receive state + live broadcasts; the
	// closure simply mutes their inbound writes (see handleOp). The gate is read
	// from the client each op (not captured) so a live sharing change can flip it
	// without reconnecting — see reevaluateAccess.
	// Provenance for everything this socket writes (TDM-40). The WS is the
	// browser's channel and has no agent path at all, so the connection's
	// resolved user id IS the derivation: signed in ⇒ "human", not ⇒ "anonymous".
	// Fixed for the life of the connection — the cookie was checked at upgrade.
	author := AuthorForSession(uid)
	var client *ws.Client
	client = ws.NewClient(wh.hub, canvasID, conn, func(cid uuid.UUID, raw []byte) {
		wh.handleOp(cid, raw, client.CanWrite(), author)
	})
	client.SetIdentity(uid, canWrite)
	wh.hub.Register(client)

	// Send current state immediately on connect
	go func() {
		c, state, edits, err := wh.store.GetCanvasState(context.Background(), canvasID)
		if err != nil {
			log.Printf("ws initial state: %v", err)
			return
		}
		c.YourRole = role // let the board render read-only when role != write
		data, _ := json.Marshal(stateMsg{Type: "state", Canvas: c, State: state, PendingEdits: edits})
		client.Send(data)
	}()

	go client.WritePump()
	client.ReadPump() // blocks until disconnect
}

func (wh *WSHandler) handleOp(canvasID uuid.UUID, raw []byte, canWrite bool, author string) {
	// Every inbound WS op is a mutation. Read-only viewers are dropped silently —
	// the gate lives here (not just in the UI) so a crafted client can't write.
	if !canWrite {
		return
	}

	// The ops below run on a background context (they outlive the read pump), so
	// the derived author is stamped onto it here — that's what applyOp and the
	// shared ensureDefaultDocument helper read.
	ctx := WithAuthor(context.Background(), author)

	// Peek at the op name (and, for a batch envelope, the sub-op list) before
	// fully decoding — the per-op struct below is filled out by applyOp for
	// each op individually.
	var probe struct {
		Op  string            `json:"op"`
		Ops []json.RawMessage `json:"ops"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return
	}

	if probe.Op == "batch" {
		// Batch envelope: apply every sub-op, then broadcast exactly ONCE. This
		// is the hot path for grid paste — a 10x20 paste is ~30 column/row ops
		// that would otherwise each trigger a full-canvas broadcast (see
		// SheetsMode.handlePasteGrid).
		wh.applyBatch(ctx, canvasID, probe.Ops)
		broadcastStateBy(ctx, wh.store, wh.hub, canvasID, "user")
		return
	}

	if err := wh.applyOp(ctx, canvasID, raw); err != nil {
		if err != errOpSkipped {
			log.Printf("ws op %s error: %v", probe.Op, err)
		}
		return
	}
	// WS ops come from a browser viewer — attribute to "user" so the agent
	// cursor doesn't fire when a human edits (even an agent-created entity).
	broadcastStateBy(ctx, wh.store, wh.hub, canvasID, "user")
}

// applyBatch executes every sub-op inside a "batch" envelope, one store call
// per sub-op via applyOp (this worktree's store.Store has no bulk
// CreateSheetColumns/CreateSheetRows — see the "loop-insert fallback" note on
// this function). What batching buys here is NOT fewer store round trips,
// it's fewer broadcasts: the caller (handleOp) fires exactly ONE
// broadcastStateBy after this returns, instead of one per sub-op — that's the
// hot-path fix for grid paste (SheetsMode.handlePasteGrid), which used to
// send one WS op per pasted column/row and so triggered one full-canvas
// broadcast each. A failing/malformed sub-op is logged and skipped; the rest
// still apply and we still broadcast once for whatever succeeded.
//
// LOOP-INSERT FALLBACK: if a future merge brings in bulk store methods
// (CreateSheetColumns(ctx, canvasID, sheetID, cols) / CreateSheetRows(ctx,
// canvasID, rows)), this is the place to coalesce consecutive
// sheet.column.add / sheet.row.add sub-ops targeting the same sheet into one
// call each, cutting store round trips too, not just broadcasts.
func (wh *WSHandler) applyBatch(ctx context.Context, canvasID uuid.UUID, ops []json.RawMessage) {
	for _, sub := range ops {
		if err := wh.applyOp(ctx, canvasID, sub); err != nil && err != errOpSkipped {
			var subProbe struct {
				Op string `json:"op"`
			}
			_ = json.Unmarshal(sub, &subProbe)
			log.Printf("ws batch sub-op %s error: %v", subProbe.Op, err)
		}
	}
}

// applyOp decodes and executes the mutation for a single op. It never
// broadcasts — the caller (handleOp) does that exactly once, whether this was
// the only op on the message or one of several inside a "batch" envelope.
// Returns errOpSkipped for malformed/no-op input (bad JSON, missing id,
// invalid enum, empty update list — the same cases that used to silently
// abort handleOp before broadcasting), or the underlying store error.
func (wh *WSHandler) applyOp(ctx context.Context, canvasID uuid.UUID, raw []byte) error {
	var msg struct {
		Op          string          `json:"op"`
		ID          *uuid.UUID      `json:"id"`
		EntityID    *uuid.UUID      `json:"entityId"`
		Instruction string          `json:"instruction"`
		Mode        string          `json:"mode"`
		MapID       string          `json:"mapId"`
		TemplateID  string          `json:"templateId"`
		Partial     json.RawMessage `json:"partial"`
		Data        json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return errOpSkipped
	}

	var mutErr error

	switch msg.Op {
	case "mode.set":
		if !isValidMode(msg.Mode) {
			log.Printf("ws op mode.set: invalid mode %q", msg.Mode)
			return errOpSkipped
		}
		_, mutErr = wh.store.SetMode(ctx, canvasID, msg.Mode)

	case "mode.enable":
		if !isEnableableMode(msg.Mode) {
			log.Printf("ws op mode.enable: invalid mode %q", msg.Mode)
			return errOpSkipped
		}
		_, mutErr = wh.store.EnableMode(ctx, canvasID, msg.Mode)

	case "map.set":
		if msg.MapID == "" || wh.maps == nil || !wh.maps.Has(msg.MapID) {
			log.Printf("ws op map.set: unknown mapId %q", msg.MapID)
			return errOpSkipped
		}
		_, mutErr = wh.store.SetMapID(ctx, canvasID, msg.MapID)

	case "template.apply":
		if !isValidMode(msg.Mode) {
			log.Printf("ws op template.apply: invalid mode %q", msg.Mode)
			return errOpSkipped
		}
		var mapPtr *string
		if msg.MapID != "" {
			if wh.maps == nil || !wh.maps.Has(msg.MapID) {
				log.Printf("ws op template.apply: unknown mapId %q", msg.MapID)
				return errOpSkipped
			}
			id := msg.MapID
			mapPtr = &id
		}
		_, mutErr = wh.store.ApplyTemplate(ctx, canvasID, msg.Mode, mapPtr)

	case "pin.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.PinPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdatePin(ctx, canvasID, *msg.ID, patch)

	case "pin.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeletePin(ctx, canvasID, *msg.ID)

	case "event.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.EventPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateEvent(ctx, canvasID, *msg.ID, patch)

	case "event.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteEvent(ctx, canvasID, *msg.ID)

	case "note.add":
		var data struct {
			Body       string     `json:"body"`
			ImageRefs  []string   `json:"imageRefs"`
			ParentID   *uuid.UUID `json:"parentId"`
			ParentKind *string    `json:"parentKind"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op note.add: bad data: %v", err)
				return errOpSkipped
			}
		}
		if data.ImageRefs == nil {
			data.ImageRefs = []string{}
		}
		n := &store.Note{
			ID:         uuid.New(),
			Kind:       "note",
			Body:       data.Body,
			ImageRefs:  data.ImageRefs,
			ParentID:   data.ParentID,
			ParentKind: data.ParentKind,
			CreatedBy:  "user",
			AuthoredBy: AuthorFromCtx(ctx), // TDM-40; "human" or "anonymous" here
		}
		// Land the note in the canvas's default notes document (creating one if
		// needed) so it belongs to a tab, matching the agent/REST path.
		docID, derr := ensureDefaultDocument(ctx, wh.store, canvasID, "notes", "user")
		if derr != nil {
			log.Printf("ws op note.add: document: %v", derr)
			return errOpSkipped
		}
		n.DocumentID = &docID
		_, mutErr = wh.store.CreateNote(ctx, canvasID, n)

	case "note.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.NotePatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateNote(ctx, canvasID, *msg.ID, patch)

	case "note.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteNote(ctx, canvasID, *msg.ID)

	case "roadmap.add":
		var data struct {
			ParentID  *uuid.UUID `json:"parentId"`
			Title     string     `json:"title"`
			Body      string     `json:"body"`
			Status    string     `json:"status"`
			Stage     string     `json:"stage"`
			Assignee  string     `json:"assignee"`
			SortOrder int        `json:"sortOrder"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op roadmap.add: bad data: %v", err)
				return errOpSkipped
			}
		}
		if data.Status == "" {
			data.Status = "todo"
		}
		r := &store.RoadmapItem{
			ID:        uuid.New(),
			Kind:      "roadmap",
			ParentID:  data.ParentID,
			Title:     data.Title,
			Body:      data.Body,
			Status:    data.Status,
			Stage:     data.Stage,
			Assignee:  data.Assignee,
			SortOrder: data.SortOrder,
			CreatedBy: "user",
		}
		docID, derr := ensureDefaultDocument(ctx, wh.store, canvasID, "roadmap", "user")
		if derr != nil {
			log.Printf("ws op roadmap.add: document: %v", derr)
			return errOpSkipped
		}
		r.DocumentID = &docID
		_, mutErr = wh.store.CreateRoadmapItem(ctx, canvasID, r)

	case "roadmap.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.RoadmapItemPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateRoadmapItem(ctx, canvasID, *msg.ID, patch)

	case "roadmap.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteRoadmapItem(ctx, canvasID, *msg.ID)

	case "roadmap.reorder":
		var payload struct {
			Updates []store.RoadmapReorder `json:"updates"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("ws op roadmap.reorder: bad payload: %v", err)
			return errOpSkipped
		}
		if len(payload.Updates) == 0 {
			return errOpSkipped
		}
		_, mutErr = wh.store.ReorderRoadmapItems(ctx, canvasID, payload.Updates)

	case "document.add":
		var data struct {
			Type      string         `json:"type"`
			Name      string         `json:"name"`
			Config    map[string]any `json:"config"`
			SortOrder int            `json:"sortOrder"`
			ParentID  *uuid.UUID     `json:"parentId"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op document.add: bad data: %v", err)
				return errOpSkipped
			}
		}
		if !docTypesCreatable[data.Type] { // excludes "chart" (needs a source sheet) + unknowns
			log.Printf("ws op document.add: invalid type %q", data.Type)
			return errOpSkipped
		}
		if data.Name == "" {
			data.Name = defaultDocNames[data.Type]
		}
		// A sheet document is 1:1 with a sheet row; the store mints the doc for us.
		if data.Type == "sheet" {
			sh := &store.Sheet{ID: uuid.New(), Kind: "sheet", Name: data.Name,
				Columns: []store.SheetColumn{}, SortOrder: data.SortOrder, CreatedBy: "user"}
			_, mutErr = wh.store.CreateSheet(ctx, canvasID, sh)
			if mutErr == nil && data.ParentID != nil && sh.DocumentID != nil {
				_, mutErr = wh.store.UpdateDocument(ctx, canvasID, *sh.DocumentID,
					store.DocumentPatch{ParentID: data.ParentID, SetParent: true})
			}
		} else {
			doc := &store.Document{ID: uuid.New(), Kind: "document", Type: data.Type,
				Name: data.Name, Config: data.Config, ParentID: data.ParentID, SortOrder: data.SortOrder,
				CreatedBy: "user", AuthoredBy: AuthorFromCtx(ctx)} // TDM-40
			_, mutErr = wh.store.CreateDocument(ctx, canvasID, doc)
		}

	case "document.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.DocumentPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateDocument(ctx, canvasID, *msg.ID, patch)

	case "document.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteDocument(ctx, canvasID, *msg.ID)

	case "document.reorder":
		var payload struct {
			Updates []store.DocumentReorder `json:"updates"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("ws op document.reorder: bad payload: %v", err)
			return errOpSkipped
		}
		if len(payload.Updates) == 0 {
			return errOpSkipped
		}
		_, mutErr = wh.store.ReorderDocuments(ctx, canvasID, payload.Updates)

	case "sheet.add":
		var data struct {
			Name      string              `json:"name"`
			Columns   []store.SheetColumn `json:"columns"`
			SortOrder int                 `json:"sortOrder"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op sheet.add: bad data: %v", err)
				return errOpSkipped
			}
		}
		if data.Name == "" {
			data.Name = "Untitled sheet"
		}
		cols := make([]store.SheetColumn, 0, len(data.Columns))
		for _, c := range data.Columns {
			if c.Type == "" {
				c.Type = "text"
			}
			if !isValidSheetColumnType(c.Type) {
				log.Printf("ws op sheet.add: invalid column type %q", c.Type)
				return errOpSkipped
			}
			if c.ID == "" {
				c.ID = uuid.New().String()
			}
			cols = append(cols, c)
		}
		sh := &store.Sheet{
			ID: uuid.New(), Kind: "sheet",
			Name: data.Name, Columns: cols, SortOrder: data.SortOrder,
			CreatedBy: "user",
		}
		_, mutErr = wh.store.CreateSheet(ctx, canvasID, sh)

	case "sheet.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.SheetPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateSheet(ctx, canvasID, *msg.ID, patch)

	case "sheet.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteSheet(ctx, canvasID, *msg.ID)

	case "sheet.column.add":
		var payload struct {
			SheetID uuid.UUID         `json:"sheetId"`
			Column  store.SheetColumn `json:"column"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("ws op sheet.column.add: bad payload: %v", err)
			return errOpSkipped
		}
		if payload.Column.Type == "" {
			payload.Column.Type = "text"
		}
		if !isValidSheetColumnType(payload.Column.Type) {
			log.Printf("ws op sheet.column.add: invalid type %q", payload.Column.Type)
			return errOpSkipped
		}
		if payload.Column.ID == "" {
			payload.Column.ID = uuid.New().String()
		}
		_, mutErr = wh.store.AddSheetColumn(ctx, canvasID, payload.SheetID, payload.Column)

	case "sheet.column.update":
		var payload struct {
			SheetID  uuid.UUID              `json:"sheetId"`
			ColumnID string                 `json:"columnId"`
			Partial  store.SheetColumnPatch `json:"partial"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return errOpSkipped
		}
		if payload.Partial.Type != nil && !isValidSheetColumnType(*payload.Partial.Type) {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateSheetColumn(ctx, canvasID, payload.SheetID, payload.ColumnID, payload.Partial)

	case "sheet.column.delete":
		var payload struct {
			SheetID  uuid.UUID `json:"sheetId"`
			ColumnID string    `json:"columnId"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteSheetColumn(ctx, canvasID, payload.SheetID, payload.ColumnID)

	case "sheet.row.add":
		var payload struct {
			SheetID   uuid.UUID      `json:"sheetId"`
			Data      map[string]any `json:"data"`
			SortOrder int            `json:"sortOrder"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return errOpSkipped
		}
		if payload.Data == nil {
			payload.Data = map[string]any{}
		}
		r := &store.SheetRow{
			ID: uuid.New(), Kind: "sheetRow", SheetID: payload.SheetID,
			Data: payload.Data, SortOrder: payload.SortOrder, CreatedBy: "user",
		}
		_, mutErr = wh.store.CreateSheetRow(ctx, canvasID, r)

	case "sheet.row.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.SheetRowPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateSheetRow(ctx, canvasID, *msg.ID, patch)

	case "sheet.row.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteSheetRow(ctx, canvasID, *msg.ID)

	case "sheet.row.reorder":
		var payload struct {
			SheetID uuid.UUID               `json:"sheetId"`
			Updates []store.SheetRowReorder `json:"updates"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return errOpSkipped
		}
		if len(payload.Updates) == 0 {
			return errOpSkipped
		}
		_, mutErr = wh.store.ReorderSheetRows(ctx, canvasID, payload.SheetID, payload.Updates)

	case "chart.add":
		var data struct {
			Name      string    `json:"name"`
			SheetID   uuid.UUID `json:"sheetId"`
			ChartType string    `json:"chartType"`
			XColumn   string    `json:"xColumn"`
			YColumns  []string  `json:"yColumns"`
			SortOrder int       `json:"sortOrder"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op chart.add: bad data: %v", err)
				return errOpSkipped
			}
		}
		if data.ChartType == "" {
			data.ChartType = "bar"
		}
		if !isValidChartType(data.ChartType) {
			log.Printf("ws op chart.add: invalid chart type %q", data.ChartType)
			return errOpSkipped
		}
		if data.Name == "" {
			data.Name = "Untitled chart"
		}
		if data.YColumns == nil {
			data.YColumns = []string{}
		}
		ch := &store.Chart{
			ID: uuid.New(), Kind: "chart",
			Name: data.Name, SheetID: data.SheetID, ChartType: data.ChartType,
			XColumn: data.XColumn, YColumns: data.YColumns, SortOrder: data.SortOrder,
			CreatedBy: "user",
		}
		_, mutErr = wh.store.CreateChart(ctx, canvasID, ch)

	case "chart.update":
		if msg.ID == nil {
			return errOpSkipped
		}
		var patch store.ChartPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return errOpSkipped
		}
		if patch.ChartType != nil && !isValidChartType(*patch.ChartType) {
			return errOpSkipped
		}
		_, mutErr = wh.store.UpdateChart(ctx, canvasID, *msg.ID, patch)

	case "chart.delete":
		if msg.ID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.DeleteChart(ctx, canvasID, *msg.ID)

	case "scoped_edit_request":
		if msg.EntityID == nil {
			return errOpSkipped
		}
		_, mutErr = wh.store.CreatePendingEdit(ctx, canvasID, *msg.EntityID, msg.Instruction)
	}

	return mutErr
}
