package ws

import (
	"sync"

	"github.com/google/uuid"
)

// Hub maintains the set of active clients per canvas and broadcasts messages.
type Hub struct {
	mu    sync.RWMutex
	rooms map[uuid.UUID]map[*Client]bool

	register   chan *Client
	unregister chan *Client
	broadcast  chan broadcastMsg
}

type broadcastMsg struct {
	canvasID uuid.UUID
	data     []byte
}

func NewHub() *Hub {
	return &Hub{
		rooms:      make(map[uuid.UUID]map[*Client]bool),
		register:   make(chan *Client, 64),
		unregister: make(chan *Client, 64),
		broadcast:  make(chan broadcastMsg, 256),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			if h.rooms[c.canvasID] == nil {
				h.rooms[c.canvasID] = make(map[*Client]bool)
			}
			h.rooms[c.canvasID][c] = true
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if room, ok := h.rooms[c.canvasID]; ok {
				delete(room, c)
				if len(room) == 0 {
					delete(h.rooms, c.canvasID)
				}
			}
			h.mu.Unlock()
			close(c.send)

		case msg := <-h.broadcast:
			h.mu.RLock()
			room := h.rooms[msg.canvasID]
			h.mu.RUnlock()
			for c := range room {
				select {
				case c.send <- msg.data:
				default:
					// slow client — drop and unregister
					h.unregister <- c
				}
			}
		}
	}
}

// Broadcast sends data to every client connected to the given canvas.
func (h *Hub) Broadcast(canvasID uuid.UUID, data []byte) {
	h.broadcast <- broadcastMsg{canvasID: canvasID, data: data}
}

func (h *Hub) Register(c *Client)   { h.register <- c }
func (h *Hub) Unregister(c *Client) { h.unregister <- c }
