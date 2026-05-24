package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

// WSHandler handles WebSocket upgrades for browser clients.
type WSHandler struct {
	store   store.Store
	hub     *ws.Hub
	authSvc *auth.Service
}

func NewWSHandler(s store.Store, hub *ws.Hub, authSvc *auth.Service) *WSHandler {
	return &WSHandler{store: s, hub: hub, authSvc: authSvc}
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
		Partial     json.RawMessage `json:"partial"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}

	ctx := context.Background()
	var mutErr error

	switch msg.Op {
	case "mode.set":
		_, mutErr = wh.store.SetMode(ctx, canvasID, msg.Mode)

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
