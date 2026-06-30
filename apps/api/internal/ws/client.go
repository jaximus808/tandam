package ws

import (
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	maxMsgSize = 64 * 1024
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

// Client is a single WebSocket connection scoped to one canvas.
type Client struct {
	hub      *Hub
	canvasID uuid.UUID
	conn     *websocket.Conn
	send     chan []byte

	// userID is the connected human (nil = anonymous) and canWrite is the live
	// write-gate. Both are stamped at connect time and can be re-evaluated after a
	// sharing change so access is revoked/downgraded in real time (see the hub's
	// ClientsFor + the api layer's reevaluateAccess), not only on the next
	// reconnect. canWrite is atomic because ReadPump reads it while a sharing
	// change writes it from another goroutine.
	userID   *uuid.UUID
	canWrite atomic.Bool

	closeOnce sync.Once
	done      chan struct{}

	// HandleMessage lets the caller react to inbound ops (direct manipulation).
	HandleMessage func(canvasID uuid.UUID, raw []byte)
}

// SetIdentity stamps the connecting user + initial write-gate on the client.
func (c *Client) SetIdentity(userID *uuid.UUID, canWrite bool) {
	c.userID = userID
	c.canWrite.Store(canWrite)
}

// UserID is the connected human, or nil for an anonymous viewer.
func (c *Client) UserID() *uuid.UUID { return c.userID }

// CanWrite reports whether this client may currently mutate the canvas.
func (c *Client) CanWrite() bool { return c.canWrite.Load() }

// SetCanWrite updates the live write-gate (used when a share downgrades/upgrades
// a connected viewer between read and write).
func (c *Client) SetCanWrite(v bool) { c.canWrite.Store(v) }

func NewClient(hub *Hub, canvasID uuid.UUID, conn *websocket.Conn, handler func(uuid.UUID, []byte)) *Client {
	return &Client{
		hub:           hub,
		canvasID:      canvasID,
		conn:          conn,
		send:          make(chan []byte, 32),
		done:          make(chan struct{}),
		HandleMessage: handler,
	}
}

// Send queues a message for delivery to this client (non-blocking; drops if full or closed).
func (c *Client) Send(data []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.send <- data:
	case <-c.done:
	default:
	}
}

// Close signals shutdown to WritePump and is safe to call multiple times.
// The send channel is intentionally not closed so concurrent Send/Broadcast
// callers cannot panic with "send on closed channel".
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
	})
}

// Done returns a channel closed when the client is shutting down.
func (c *Client) Done() <-chan struct{} { return c.done }

// Upgrade upgrades an HTTP request to a WebSocket and returns the connection.
func Upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return upgrader.Upgrade(w, r, nil)
}

// ReadPump reads messages from the WebSocket and forwards them to HandleMessage.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.Unregister(c)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMsgSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			break
		}
		if c.HandleMessage != nil {
			c.HandleMessage(c.canvasID, msg)
		}
	}
}

// WritePump writes messages from the send channel to the WebSocket.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case <-c.done:
			// Flush anything already queued (notably a final "access revoked"
			// notice a sharing change enqueued just before Close) so a
			// server-initiated kick still reaches the client before the close
			// frame. Safe because Close() never closes c.send.
			for {
				select {
				case msg := <-c.send:
					c.conn.SetWriteDeadline(time.Now().Add(writeWait))
					if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
						return
					}
					continue
				default:
				}
				break
			}
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		case msg := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
