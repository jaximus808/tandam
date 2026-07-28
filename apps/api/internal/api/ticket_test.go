package api

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// fakeTicketCounter mimics the reserve_task_tickets RPC: an atomic
// increment-by-n that returns the first of the reserved range. The mutex plays
// the role of Postgres row-level locking on the canvas row — the property the
// real RPC's single-UPDATE gives us. (True DB-level concurrency can't be
// exercised here — there is no fake Postgres in this harness — so this tests
// the reservation/assignment logic on top of an atomic reserve primitive.)
type fakeTicketCounter struct {
	mu   sync.Mutex
	next int
}

func (f *fakeTicketCounter) reserve(n int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	first := f.next
	f.next += n
	return first, nil
}

func task(title string) *store.Action {
	return &store.Action{ID: uuid.New(), Kind: "action", Type: "task", State: "proposed",
		Payload: json.RawMessage(`{"title":"` + title + `"}`)}
}

// Concurrent creations — single tasks and mixed batches — must end up with
// unique tickets, consecutive within each batch, and none on non-task actions.
func TestAssignTaskTicketsConcurrentUnique(t *testing.T) {
	counter := &fakeTicketCounter{next: 1}
	const goroutines = 40

	batches := make([][]*store.Action, goroutines)
	var wg sync.WaitGroup
	for i := range goroutines {
		// Alternate the shapes concurrent sessions actually produce: a single
		// task (canvas_task_add), a 3-task batch (canvas_task_add_batch), and a
		// mixed batch with a non-task action interleaved.
		var batch []*store.Action
		switch i % 3 {
		case 0:
			batch = []*store.Action{task("solo")}
		case 1:
			batch = []*store.Action{task("a"), task("b"), task("c")}
		default:
			batch = []*store.Action{
				task("x"),
				{ID: uuid.New(), Kind: "action", Type: "navigate", State: "proposed"},
				task("y"),
			}
		}
		batches[i] = batch
		wg.Add(1)
		go func(b []*store.Action) {
			defer wg.Done()
			if err := assignTaskTickets(counter.reserve, b); err != nil {
				t.Errorf("assignTaskTickets: %v", err)
			}
		}(batch)
	}
	wg.Wait()

	seen := map[int]bool{}
	total := 0
	for _, batch := range batches {
		prev := -1
		for _, a := range batch {
			if a.Type != "task" {
				if a.Ticket != nil {
					t.Fatalf("non-task action got ticket %d", *a.Ticket)
				}
				continue
			}
			if a.Ticket == nil {
				t.Fatal("task action missing ticket")
			}
			total++
			if seen[*a.Ticket] {
				t.Fatalf("duplicate ticket %d across concurrent creations", *a.Ticket)
			}
			seen[*a.Ticket] = true
			// Within one batch, tickets are consecutive in task order (one
			// reservation of N — non-task actions don't consume a number).
			if prev != -1 && *a.Ticket != prev+1 {
				t.Fatalf("batch tickets not consecutive: %d after %d", *a.Ticket, prev)
			}
			prev = *a.Ticket
		}
	}
	// Every number 1..total was handed out exactly once — sequential, no gaps.
	if total != counter.next-1 {
		t.Fatalf("reserved %d numbers but assigned %d", counter.next-1, total)
	}
	for n := 1; n <= total; n++ {
		if !seen[n] {
			t.Fatalf("ticket %d skipped — sequence has a gap", n)
		}
	}
}

// A batch with no tasks must not reserve anything.
func TestAssignTaskTicketsNoTasksNoReservation(t *testing.T) {
	counter := &fakeTicketCounter{next: 1}
	batch := []*store.Action{{ID: uuid.New(), Kind: "action", Type: "navigate", State: "proposed"}}
	if err := assignTaskTickets(counter.reserve, batch); err != nil {
		t.Fatalf("assignTaskTickets: %v", err)
	}
	if counter.next != 1 {
		t.Fatalf("reserved tickets for a task-free batch (next=%d)", counter.next)
	}
}

// The serialization layer must add the display form ("TDM-<n>") next to the
// stored integer, and omit both when the action has no ticket.
func TestActionTicketSerialization(t *testing.T) {
	n := 142
	withTicket, err := json.Marshal(&store.Action{ID: uuid.New(), Kind: "action", Type: "task",
		State: "approved", Payload: json.RawMessage(`{}`), Ticket: &n})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(withTicket), `"ticketId":"TDM-142"`) {
		t.Fatalf("serialized action missing ticketId display form: %s", withTicket)
	}
	if !strings.Contains(string(withTicket), `"ticket":142`) {
		t.Fatalf("serialized action missing integer ticket: %s", withTicket)
	}

	without, err := json.Marshal(&store.Action{ID: uuid.New(), Kind: "action", Type: "navigate",
		State: "proposed", Payload: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(without), "ticket") {
		t.Fatalf("ticket fields leaked into a ticketless action: %s", without)
	}
}
