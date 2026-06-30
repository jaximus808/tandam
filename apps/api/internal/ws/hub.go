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
	quit       chan struct{}
	quitOnce   sync.Once
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
		quit:       make(chan struct{}),
	}
}

// Shutdown signals every connected client to close cleanly and exits Run.
// Safe to call multiple times; subsequent calls are no-ops.
func (h *Hub) Shutdown() {
	h.quitOnce.Do(func() {
		close(h.quit)
	})
}

func (h *Hub) Run() {
	for {
		select {
		case <-h.quit:
			h.mu.Lock()
			for _, room := range h.rooms {
				for c := range room {
					c.Close()
				}
			}
			h.rooms = map[uuid.UUID]map[*Client]bool{}
			h.mu.Unlock()
			return

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
			c.Close()

		case msg := <-h.broadcast:
			h.mu.RLock()
			room := h.rooms[msg.canvasID]
			h.mu.RUnlock()
			for c := range room {
				select {
				case <-c.done:
					// client is shutting down; skip
				case c.send <- msg.data:
				default:
					// slow client — drop and unregister
					select {
					case h.unregister <- c:
					default:
					}
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

// ClientsFor returns a snapshot of the clients currently connected to a canvas,
// so a sharing change can re-evaluate each one's access live. The slice is a
// copy — safe to range after the lock is dropped.
func (h *Hub) ClientsFor(canvasID uuid.UUID) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[canvasID]
	out := make([]*Client, 0, len(room))
	for c := range room {
		out = append(out, c)
	}
	return out
}
