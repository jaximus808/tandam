package api

import (
	"context"
	"encoding/json"
	"log"

	"github.com/agentcanvas/api/internal/store"
	"github.com/agentcanvas/api/internal/ws"
	"github.com/google/uuid"
)

type stateMsg struct {
	Type         string              `json:"type"`
	Canvas       *store.Canvas       `json:"canvas"`
	State        *store.CanvasState  `json:"state"`
	PendingEdits []*store.PendingEdit `json:"pendingEdits"`
}

// broadcastState loads the full canvas state and sends it to all WS clients on that canvas.
func broadcastState(ctx context.Context, st store.Store, hub *ws.Hub, canvasID uuid.UUID) {
	canvas, state, edits, err := st.GetCanvasState(ctx, canvasID)
	if err != nil {
		log.Printf("broadcastState: %v", err)
		return
	}
	data, err := json.Marshal(stateMsg{
		Type:         "state",
		Canvas:       canvas,
		State:        state,
		PendingEdits: edits,
	})
	if err != nil {
		log.Printf("broadcastState marshal: %v", err)
		return
	}
	hub.Broadcast(canvasID, data)
}
