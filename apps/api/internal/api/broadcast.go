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
	Type         string               `json:"type"`
	Canvas       *store.Canvas        `json:"canvas"`
	State        *store.CanvasState   `json:"state"`
	PendingEdits []*store.PendingEdit `json:"pendingEdits"`
	// LastChangeBy names who triggered this broadcast ("agent" | "user"), so
	// viewers can render the agent cursor only on agent-authored changes. Set by
	// path: HTTP mutations (the MCP gateway) are "agent", WS ops are "user".
	// Omitted on the initial connect snapshot (no change to attribute).
	LastChangeBy string `json:"lastChangeBy,omitempty"`
}

// broadcastState loads the full canvas state and sends it to all WS clients on
// that canvas. Mutations arriving over HTTP are the agent/gateway path, so this
// attributes the change to "agent"; the WS (user) path calls broadcastStateBy.
func broadcastState(ctx context.Context, st store.Store, hub *ws.Hub, canvasID uuid.UUID) {
	broadcastStateBy(ctx, st, hub, canvasID, "agent")
}

func broadcastStateBy(ctx context.Context, st store.Store, hub *ws.Hub, canvasID uuid.UUID, by string) {
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
		LastChangeBy: by,
	})
	if err != nil {
		log.Printf("broadcastState marshal: %v", err)
		return
	}
	hub.Broadcast(canvasID, data)
}
