package ws

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// testClient builds a Client with no socket: the hub only ever touches
// canvasID, send and done, so a nil conn is enough to exercise registration,
// fan-out and the metrics seam without a network.
func testClient(canvasID uuid.UUID) *Client {
	return &Client{
		canvasID: canvasID,
		send:     make(chan []byte, 8),
		done:     make(chan struct{}),
	}
}

// recordingObserver is the metrics seam stand-in (metrics.Registry implements
// the same single method).
type recordingObserver struct {
	mu   sync.Mutex
	durs []time.Duration
}

func (o *recordingObserver) ObserveBroadcast(d time.Duration) {
	o.mu.Lock()
	o.durs = append(o.durs, d)
	o.mu.Unlock()
}

func (o *recordingObserver) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.durs)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ClientCount is the ws_clients gauge: it must sum every room and follow
// register/unregister, because the metrics endpoint pulls it at scrape time.
func TestHubClientCount(t *testing.T) {
	h := NewHub()
	go h.Run()
	defer h.Shutdown()

	if got := h.ClientCount(); got != 0 {
		t.Fatalf("fresh hub ClientCount = %d, want 0", got)
	}

	canvasA, canvasB := uuid.New(), uuid.New()
	a1, a2, b1 := testClient(canvasA), testClient(canvasA), testClient(canvasB)
	h.Register(a1)
	h.Register(a2)
	h.Register(b1)
	waitFor(t, "3 clients across 2 canvases", func() bool { return h.ClientCount() == 3 })

	h.Unregister(a2)
	waitFor(t, "count to drop after unregister", func() bool { return h.ClientCount() == 2 })

	h.Unregister(a1)
	h.Unregister(b1)
	waitFor(t, "count to return to 0", func() bool { return h.ClientCount() == 0 })
}

// The observer sees exactly one observation per broadcast, and fan-out still
// delivers — the timing seam must not change hub behavior.
func TestHubBroadcastObserver(t *testing.T) {
	h := NewHub()
	obs := &recordingObserver{}
	h.SetObserver(obs)
	go h.Run()
	defer h.Shutdown()

	canvasID := uuid.New()
	c := testClient(canvasID)
	h.Register(c)
	waitFor(t, "client registered", func() bool { return h.ClientCount() == 1 })

	h.Broadcast(canvasID, []byte(`{"type":"state"}`))
	h.Broadcast(canvasID, []byte(`{"type":"state"}`))
	waitFor(t, "2 broadcasts observed", func() bool { return obs.count() == 2 })

	for i := 0; i < 2; i++ {
		select {
		case got := <-c.send:
			if string(got) != `{"type":"state"}` {
				t.Errorf("payload = %s", got)
			}
		case <-time.After(time.Second):
			t.Fatal("client never received the broadcast")
		}
	}

	// A broadcast to a canvas with nobody connected is still measured: an empty
	// fan-out is a real (and very fast) fan-out, and silently skipping it would
	// bias p50 upward.
	h.Broadcast(uuid.New(), []byte(`{}`))
	waitFor(t, "empty-room broadcast observed", func() bool { return obs.count() == 3 })
}

// A hub with no observer is the metrics-disabled deployment: broadcasts must
// still work and nothing may panic.
func TestHubWithoutObserver(t *testing.T) {
	h := NewHub()
	go h.Run()
	defer h.Shutdown()

	canvasID := uuid.New()
	c := testClient(canvasID)
	h.Register(c)
	waitFor(t, "client registered", func() bool { return h.ClientCount() == 1 })

	h.Broadcast(canvasID, []byte("x"))
	select {
	case got := <-c.send:
		if string(got) != "x" {
			t.Errorf("payload = %s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("broadcast lost with no observer wired")
	}
}
