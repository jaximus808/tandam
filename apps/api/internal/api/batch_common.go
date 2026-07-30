package api

import (
	"fmt"
	"net/http"
)

// Batch write honesty (TDM-138).
//
// Three problems this file fixes, all variants of "a batch reported success it
// didn't earn":
//
//  1. A well-formed id that is absent — or belongs to ANOTHER canvas — is a
//     silent no-op at the store (the canvas_id predicate matches 0 rows), yet the
//     old handlers echoed every INPUT id back as "applied". runBatchAffected
//     builds the applied set from rows-affected instead, so a no-op / cross-tenant
//     id is never reported as a write that happened.
//  2. On the first per-item error the old handlers returned 500 BEFORE bumping the
//     version or broadcasting, so items that DID land stayed invisible to
//     connected boards until some later unrelated broadcast. finishBatch converges
//     whatever landed even on a partial failure.
//  3. No cap on items per request. maxBatchItems bounds it.

// maxBatchItems caps how many elements one batch request may carry. Bounded
// concurrency (batchConcurrency) caps SIMULTANEOUS store calls, but not the
// TOTAL — without this a single request could enqueue thousands of writes and
// pin a request goroutine (and a slice of DB round-trips) open. 500 sits far
// above any legitimate bulk edit an agent or the web app issues in one call.
const maxBatchItems = 500

// tooManyBatchItems writes a 400 and returns true when n exceeds the cap, so a
// handler can `if tooManyBatchItems(w, len(body.Items)) { return }` right after
// its empty-check.
func tooManyBatchItems(w http.ResponseWriter, n int) bool {
	if n > maxBatchItems {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("too many items: %d exceeds the per-batch maximum of %d — split it into smaller batches", n, maxBatchItems))
		return true
	}
	return false
}

// runBatchAffected runs apply for each index in [0,n) with bounded concurrency
// (see runBatch). apply returns rows-affected for that item; an item with
// affected == 0 (a well-formed but absent / cross-canvas id) is NOT counted as
// applied — which is what stops a no-op being echoed back as a successful write.
//
// Returns the applied INDICES in input order and the first error observed. All
// items still run to completion; the applied set and the error are independent,
// so a later item's success is reported even if an earlier one errored.
func runBatchAffected(n int, apply func(i int) (int, error)) (applied []int, firstErr error) {
	if n <= 0 {
		return nil, nil
	}
	affected := make([]int, n)
	errs := make([]error, n)
	_ = runBatch(n, func(i int) error {
		a, err := apply(i)
		affected[i] = a
		errs[i] = err
		return err
	})
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			if firstErr == nil {
				firstErr = errs[i]
			}
			continue
		}
		if affected[i] > 0 {
			applied = append(applied, i)
		}
	}
	return applied, firstErr
}

// finishBatch is the single tail of every batch UPDATE/DELETE. It bumps the
// canvas version once (only when something actually landed) and fires the one
// trailing state broadcast — and it does so EVEN WHEN the batch partially failed,
// so already-applied items converge on connected boards instead of being stranded
// divergent until an unrelated later broadcast (TDM-138). `key` is "updated" or
// "deleted".
//
// On a partial failure the response is still a 500 (the pre-existing contract:
// any item error fails the batch), but the convergence has already happened, which
// is the behavioural fix. On full success it returns 200 with the applied ids.
func (h *Handler) finishBatch(w http.ResponseWriter, r *http.Request, applied []string, batchErr error, key string) {
	canvasID := CanvasIDFromCtx(r.Context())
	if len(applied) > 0 {
		if _, err := h.store.BumpCanvasVersion(r.Context(), canvasID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	broadcastStateAsync(r.Context(), h.store, h.hub, canvasID)
	if batchErr != nil {
		writeError(w, http.StatusInternalServerError, batchErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{key: applied})
}

// appliedIDs maps applied indices back to their string ids, in input order.
func appliedIDs(idx []int, id func(i int) string) []string {
	out := make([]string, 0, len(idx))
	for _, i := range idx {
		out = append(out, id(i))
	}
	return out
}
