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
