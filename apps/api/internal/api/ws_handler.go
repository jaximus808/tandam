package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/maps"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

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

	conn, err := ws.Upgrade(w, r)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	canvasID := canvas.ID
	client := ws.NewClient(wh.hub, canvasID, conn, wh.handleOp)
	wh.hub.Register(client)

	// Send current state immediately on connect
	go func() {
		c, state, edits, err := wh.store.GetCanvasState(context.Background(), canvasID)
		if err != nil {
			log.Printf("ws initial state: %v", err)
			return
		}
		data, _ := json.Marshal(stateMsg{Type: "state", Canvas: c, State: state, PendingEdits: edits})
		client.Send(data)
	}()

	go client.WritePump()
	client.ReadPump() // blocks until disconnect
}

func (wh *WSHandler) handleOp(canvasID uuid.UUID, raw []byte) {
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
		return
	}

	ctx := context.Background()
	var mutErr error

	switch msg.Op {
	case "mode.set":
		if !isValidMode(msg.Mode) {
			log.Printf("ws op mode.set: invalid mode %q", msg.Mode)
			return
		}
		_, mutErr = wh.store.SetMode(ctx, canvasID, msg.Mode)

	case "map.set":
		if msg.MapID == "" || wh.maps == nil || !wh.maps.Has(msg.MapID) {
			log.Printf("ws op map.set: unknown mapId %q", msg.MapID)
			return
		}
		_, mutErr = wh.store.SetMapID(ctx, canvasID, msg.MapID)

	case "template.apply":
		if !isValidMode(msg.Mode) {
			log.Printf("ws op template.apply: invalid mode %q", msg.Mode)
			return
		}
		var mapPtr *string
		if msg.MapID != "" {
			if wh.maps == nil || !wh.maps.Has(msg.MapID) {
				log.Printf("ws op template.apply: unknown mapId %q", msg.MapID)
				return
			}
			id := msg.MapID
			mapPtr = &id
		}
		_, mutErr = wh.store.ApplyTemplate(ctx, canvasID, msg.Mode, mapPtr)

	case "pin.update":
		if msg.ID == nil {
			return
		}
		var patch store.PinPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdatePin(ctx, canvasID, *msg.ID, patch)

	case "pin.delete":
		if msg.ID == nil {
			return
		}
		_, mutErr = wh.store.DeletePin(ctx, canvasID, *msg.ID)

	case "event.update":
		if msg.ID == nil {
			return
		}
		var patch store.EventPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdateEvent(ctx, canvasID, *msg.ID, patch)

	case "event.delete":
		if msg.ID == nil {
			return
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
				return
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
		}
		_, mutErr = wh.store.CreateNote(ctx, canvasID, n)

	case "note.update":
		if msg.ID == nil {
			return
		}
		var patch store.NotePatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdateNote(ctx, canvasID, *msg.ID, patch)

	case "note.delete":
		if msg.ID == nil {
			return
		}
		_, mutErr = wh.store.DeleteNote(ctx, canvasID, *msg.ID)

	case "roadmap.add":
		var data struct {
			ParentID  *uuid.UUID `json:"parentId"`
			Title     string     `json:"title"`
			Body      string     `json:"body"`
			Status    string     `json:"status"`
			SortOrder int        `json:"sortOrder"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op roadmap.add: bad data: %v", err)
				return
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
			SortOrder: data.SortOrder,
			CreatedBy: "user",
		}
		_, mutErr = wh.store.CreateRoadmapItem(ctx, canvasID, r)

	case "roadmap.update":
		if msg.ID == nil {
			return
		}
		var patch store.RoadmapItemPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdateRoadmapItem(ctx, canvasID, *msg.ID, patch)

	case "roadmap.delete":
		if msg.ID == nil {
			return
		}
		_, mutErr = wh.store.DeleteRoadmapItem(ctx, canvasID, *msg.ID)

	case "roadmap.reorder":
		var payload struct {
			Updates []store.RoadmapReorder `json:"updates"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("ws op roadmap.reorder: bad payload: %v", err)
			return
		}
		if len(payload.Updates) == 0 {
			return
		}
		_, mutErr = wh.store.ReorderRoadmapItems(ctx, canvasID, payload.Updates)

	case "sheet.add":
		var data struct {
			Name      string              `json:"name"`
			Columns   []store.SheetColumn `json:"columns"`
			SortOrder int                 `json:"sortOrder"`
		}
		if len(msg.Data) > 0 {
			if err := json.Unmarshal(msg.Data, &data); err != nil {
				log.Printf("ws op sheet.add: bad data: %v", err)
				return
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
				return
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
			return
		}
		var patch store.SheetPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdateSheet(ctx, canvasID, *msg.ID, patch)

	case "sheet.delete":
		if msg.ID == nil {
			return
		}
		_, mutErr = wh.store.DeleteSheet(ctx, canvasID, *msg.ID)

	case "sheet.column.add":
		var payload struct {
			SheetID uuid.UUID         `json:"sheetId"`
			Column  store.SheetColumn `json:"column"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			log.Printf("ws op sheet.column.add: bad payload: %v", err)
			return
		}
		if payload.Column.Type == "" {
			payload.Column.Type = "text"
		}
		if !isValidSheetColumnType(payload.Column.Type) {
			log.Printf("ws op sheet.column.add: invalid type %q", payload.Column.Type)
			return
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
			return
		}
		if payload.Partial.Type != nil && !isValidSheetColumnType(*payload.Partial.Type) {
			return
		}
		_, mutErr = wh.store.UpdateSheetColumn(ctx, canvasID, payload.SheetID, payload.ColumnID, payload.Partial)

	case "sheet.column.delete":
		var payload struct {
			SheetID  uuid.UUID `json:"sheetId"`
			ColumnID string    `json:"columnId"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return
		}
		_, mutErr = wh.store.DeleteSheetColumn(ctx, canvasID, payload.SheetID, payload.ColumnID)

	case "sheet.row.add":
		var payload struct {
			SheetID   uuid.UUID      `json:"sheetId"`
			Data      map[string]any `json:"data"`
			SortOrder int            `json:"sortOrder"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return
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
			return
		}
		var patch store.SheetRowPatch
		if err := json.Unmarshal(msg.Partial, &patch); err != nil {
			return
		}
		_, mutErr = wh.store.UpdateSheetRow(ctx, canvasID, *msg.ID, patch)

	case "sheet.row.delete":
		if msg.ID == nil {
			return
		}
		_, mutErr = wh.store.DeleteSheetRow(ctx, canvasID, *msg.ID)

	case "sheet.row.reorder":
		var payload struct {
			SheetID uuid.UUID               `json:"sheetId"`
			Updates []store.SheetRowReorder `json:"updates"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return
		}
		if len(payload.Updates) == 0 {
			return
		}
		_, mutErr = wh.store.ReorderSheetRows(ctx, canvasID, payload.SheetID, payload.Updates)

	case "scoped_edit_request":
		if msg.EntityID == nil {
			return
		}
		_, mutErr = wh.store.CreatePendingEdit(ctx, canvasID, *msg.EntityID, msg.Instruction)
	}

	if mutErr != nil {
		log.Printf("ws op %s error: %v", msg.Op, mutErr)
		return
	}
	broadcastState(ctx, wh.store, wh.hub, canvasID)
}
