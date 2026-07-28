package api

import (
	"context"
	"log"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// Ticket assignment for tasks (migration 0034).
//
// Every action of type "task" gets a per-canvas sequential ticket number,
// displayed as "TDM-<n>" (the display string is built in the store
// serialization layer; only the integer is stored). Numbers come from the
// reserve_task_tickets RPC — a single atomic UPDATE on the canvas row — so
// concurrent creations can never collide, and a batch of k tasks reserves k
// consecutive numbers in ONE call.

// ticketReserver reserves n consecutive ticket numbers for one canvas and
// returns the first of the range. In production it is backed by
// store.ReserveTaskTickets; tests substitute an in-memory counter.
type ticketReserver func(n int) (int, error)

// assignTaskTickets stamps consecutive ticket numbers onto every type="task"
// action in the slice, in order, with a single reservation call. Non-task
// actions (navigate, etc. — and any future types like "epic") are left with a
// nil ticket. No-op when the slice contains no tasks.
func assignTaskTickets(reserve ticketReserver, actions []*store.Action) error {
	count := 0
	for _, a := range actions {
		if a.Type == "task" {
			count++
		}
	}
	if count == 0 {
		return nil
	}
	first, err := reserve(count)
	if err != nil {
		return err
	}
	next := first
	for _, a := range actions {
		if a.Type != "task" {
			continue
		}
		n := next // fresh variable per action — the struct holds a pointer
		a.Ticket = &n
		next++
	}
	return nil
}

// assignTicketsBestEffort is the handler entry point: reserve + stamp tickets
// for any tasks among the actions about to be created. Failure is logged, not
// fatal — a task without a ticket beats a failed creation (e.g. in the window
// where the API is deployed but migration 0034 hasn't been applied yet).
func (h *Handler) assignTicketsBestEffort(ctx context.Context, canvasID uuid.UUID, actions ...*store.Action) {
	reserve := func(n int) (int, error) {
		return h.store.ReserveTaskTickets(ctx, canvasID, n)
	}
	if err := assignTaskTickets(reserve, actions); err != nil {
		log.Printf("ticket assignment failed for canvas %s (tasks created without tickets): %v", canvasID, err)
	}
}
