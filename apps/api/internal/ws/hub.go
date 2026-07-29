package ws

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// Observer is the optional metrics seam (TDM-42). The hub reports how long each
// broadcast's fan-out took; whoever wires it decides what that means. Declared
// here, rather than importing the metrics package, so ws keeps no dependency on
// observability — and so a nil observer is simply "nobody is watching".
//
// Implementations must be cheap and non-blocking: this runs inside the single
// hub goroutine, so anything slow here delays every canvas on the process.
type Observer interface {
	ObserveBroadcast(d time.Duration)
}

// Hub maintains the set of active clients per canvas and broadcasts messages.
type Hub struct {
	mu    sync.RWMutex
	rooms map[uuid.UUID]map[*Client]bool
	// observer is read under mu in the broadcast path, so SetObserver is safe
	// on a hub that is already Run()ing.
	observer Observer

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
			start := time.Now()
			h.mu.RLock()
			room := h.rooms[msg.canvasID]
			obs := h.observer
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
			// Fan-out cost is the number that decides whether a busy canvas feels
			// live: it grows with room size and with how many clients are slow.
			// Measured around the whole dispatch, room lookup included.
			if obs != nil {
				obs.ObserveBroadcast(time.Since(start))
			}
		}
	}
}

// SetObserver attaches (or clears, with nil) the metrics seam. Safe to call at
// any time, including on a running hub.
func (h *Hub) SetObserver(o Observer) {
	h.mu.Lock()
	h.observer = o
	h.mu.Unlock()
}

// ClientCount returns how many clients are connected across every canvas — the
// ws_clients gauge. Pulled at scrape time rather than maintained as a counter:
// the rooms map is the authoritative answer, and a pushed counter would drift
// on every dropped-client path.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, room := range h.rooms {
		n += len(room)
	}
	return n
}

// Broadcast sends data to every client connected to the given canvas.
func (h *Hub) Broadcast(canvasID uuid.UUID, data []byte) {
	h.broadcast <- broadcastMsg{canvasID: canvasID, data: data}
}

func (h *Hub) Register(c *Client)   { h.register <- c }
func (h *Hub) Unregister(c *Client) { h.unregister <- c }

// DrainBroadcasts pops every payload queued on the broadcast channel and
// returns it, oldest first. It exists for TESTS: a handler test can hand a
// hub that is not Run()ing to a Handler, exercise a mutation, and assert on
// exactly what the canvas was pinged with — no WebSocket, no client, no
// goroutine. With Run() going this is racy by construction (the loop consumes
// the same channel), so production code must never call it.
func (h *Hub) DrainBroadcasts() [][]byte {
	out := [][]byte{}
	for {
		select {
		case msg := <-h.broadcast:
			out = append(out, msg.data)
		default:
			return out
		}
	}
}

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
