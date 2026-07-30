package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// contextMsg is the JSON envelope around the markdown bundle. The markdown is
// the payload; everything else is metadata a caller can act on without parsing
// prose (cache keys, "is this board rotting", queue depth alerts).
type contextMsg struct {
	Type        string         `json:"type"` // "context"
	Markdown    string         `json:"markdown"`
	GeneratedAt time.Time      `json:"generatedAt"`
	Counts      map[string]int `json:"counts"`
	Hint        string         `json:"_hint"`
}

// GET /api/canvas/context?taskId=<id>   (canvas JWT required; any role)
//
// ONE call for everything an agent needs on connect: the canvas's briefing, the
// approved queue, and — with ?taskId= — that task hydrated with its linked
// context, all as AGENTS.md-shaped markdown with freshness annotated inline.
//
// It replaces the old opening sequence (state_read → task_list → task_get, three
// round trips and a full-canvas dump the agent had to summarize itself) with a
// single read shaped for the reader.
//
// PERFORMANCE. The p95 budget is 250ms server-side, and every Supabase call is a
// REST round trip, so the fetches are arranged in waves rather than a chain:
//
//	wave 1  GetCanvasByID                      (needed: briefing_doc_id)
//	wave 2  briefing doc | briefing notes | approved tasks | epics | the task
//	wave 3  GetLinkedEntities                  (needs the task's payload.linkedIds)
//
// Two waves for the common read, three with ?taskId= — instead of five or seven
// serial trips. Nothing here is a per-item query: epic titles for the whole
// queue come from ONE list of epics, not one lookup per task.
func (h *Handler) GetContext(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	canvasID := CanvasIDFromCtx(ctx)

	// One instant for the whole bundle. Every freshness annotation in the
	// markdown and every count in the envelope is derived against this same
	// `now`, so a slow request can't have its briefing judged against one clock
	// and its linked context against another.
	now := time.Now().UTC()

	var taskID uuid.UUID
	if raw := strings.TrimSpace(r.URL.Query().Get("taskId")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "taskId must be a task action id")
			return
		}
		taskID = id
	}

	// Like GET /api/canvas/state, this is the agent read path — pulse it to
	// connected viewers as live "reading" presence.
	broadcastActivity(h.hub, canvasID, "read")

	canvas, err := h.store.GetCanvasByID(ctx, canvasID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	bundle := contextBundle{Canvas: canvas, EpicTitles: map[uuid.UUID]string{}}

	// ── Wave 2: independent reads, in parallel ────────────────────────────────
	// Each closure writes a DIFFERENT field of `bundle`, so the concurrent writes
	// touch disjoint memory (runBatch's contract).
	var taskErr error
	var fetches []func() error

	if canvas.BriefingDocID != nil {
		docID := *canvas.BriefingDocID
		fetches = append(fetches,
			func() error {
				doc, err := h.store.GetDocument(ctx, canvasID, docID)
				if err != nil {
					// A dangling designation must not fail the whole read — the
					// bundle degrades to "no briefing designated", which is the
					// honest thing to say when the document is gone.
					return nil
				}
				bundle.BriefingDoc = doc
				return nil
			},
			func() error {
				notes, err := h.store.ListNotesByDocument(ctx, canvasID, docID)
				if err != nil {
					return err
				}
				bundle.BriefingNotes = notes
				return nil
			})
	}

	fetches = append(fetches, func() error {
		tasks, err := h.store.ListActions(ctx, canvasID, "approved", "task", "")
		if err != nil {
			return err
		}
		bundle.ApprovedTasks = tasks
		return nil
	})

	// Every epic on the canvas in one query — the queue names each task's epic
	// without a lookup per task. Epics are a handful of rows even on a busy board.
	var epics []*store.Action
	fetches = append(fetches, func() error {
		list, err := h.store.ListActions(ctx, canvasID, "", "epic", "")
		if err != nil {
			return err
		}
		epics = list
		return nil
	})

	if taskID != uuid.Nil {
		fetches = append(fetches, func() error {
			task, err := h.store.GetAction(ctx, canvasID, taskID)
			if err != nil {
				// Recorded, not returned: a missing task is a 404 about the
				// taskId, not a 500 about the canvas.
				taskErr = err
				return nil
			}
			bundle.Task = task
			return nil
		})
	}

	if err := runBatch(len(fetches), func(i int) error { return fetches[i]() }); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if taskErr != nil {
		writeError(w, http.StatusNotFound, taskErr.Error())
		return
	}
	bundle.Epics = epics
	for _, e := range epics {
		bundle.EpicTitles[e.ID] = decodeTaskPayload(e.Payload).Title
	}

	// ── Wave 3: the task's linked context (depends on its payload) ────────────
	if bundle.Task != nil {
		linked, err := h.store.GetLinkedEntities(ctx, canvasID, decodeTaskPayload(bundle.Task.Payload).LinkedIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		bundle.TaskLinks = linked
	}

	writeJSON(w, http.StatusOK, contextMsg{
		Type:        "context",
		Markdown:    renderContextMarkdown(bundle, now),
		GeneratedAt: now,
		Counts:      contextCounts(bundle, now),
		Hint: "One-call connect bundle: briefing + approved queue (+ one task with ?taskId=). " +
			"Freshness is annotated inline — a [stale] item is shown, not hidden, so weigh it before citing it. " +
			"For the whole board use canvas_state_read.",
	})
}
