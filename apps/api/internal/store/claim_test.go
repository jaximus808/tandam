package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeActionsServer is a minimal in-memory PostgREST standing in for the
// actions table (one row). The conditional UPDATE is applied under a mutex —
// the same per-row atomicity Postgres provides — so these tests exercise the
// real supabaseStore claim path end to end: the state predicate on the URL,
// the return=representation row count that decides winner vs loser, and the
// 0-row re-read that disambiguates not-found / already-claimed / wrong-state.
type fakeActionsServer struct {
	mu  sync.Mutex
	row map[string]any
}

func newFakeActionsServer(canvasID, actionID uuid.UUID, state string) *fakeActionsServer {
	return &fakeActionsServer{
		row: map[string]any{
			"id":             actionID.String(),
			"canvas_id":      canvasID.String(),
			"type":           "task",
			"state":          state,
			"payload":        map[string]any{"title": "one task, two claimants"},
			"proposed_by":    "planner",
			"linked_pin_ids": []string{},
			"created_at":     "2026-07-27T00:00:00Z",
			"updated_at":     "2026-07-27T00:00:00Z",
		},
	}
}

// matches applies PostgREST eq./lt. filters from the query string to the row.
func (f *fakeActionsServer) matches(q map[string][]string) bool {
	for key, vals := range q {
		if key == "select" || len(vals) == 0 {
			continue
		}
		if want, ok := strings.CutPrefix(vals[0], "eq."); ok {
			if got, _ := f.row[key].(string); got != want {
				return false
			}
			continue
		}
		if want, ok := strings.CutPrefix(vals[0], "lt."); ok {
			// Timestamp lt — the claim-TTL cutoff predicate. Parse both sides:
			// lexicographic compare lies across differing fractional-second
			// widths. A nil/unparsable row value doesn't match, mirroring
			// Postgres (`NULL < x` is not true).
			got, _ := f.row[key].(string)
			gt, gerr := time.Parse(time.RFC3339Nano, got)
			wt, werr := time.Parse(time.RFC3339Nano, want)
			if gerr != nil || werr != nil || !gt.Before(wt) {
				return false
			}
			continue
		}
		// other operators aren't used by the claim path
	}
	return true
}

func (f *fakeActionsServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/rpc/bump_canvas_version"):
			w.Write([]byte("1"))
		case strings.HasSuffix(r.URL.Path, "/actions") && r.Method == http.MethodGet:
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.matches(r.URL.Query()) {
				json.NewEncoder(w).Encode([]any{f.row})
			} else {
				w.Write([]byte("[]"))
			}
		case strings.HasSuffix(r.URL.Path, "/actions") && r.Method == http.MethodPatch:
			var patch map[string]any
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				http.Error(w, `{"code":"400","message":"bad body"}`, 400)
				return
			}
			// Read-match-write under one lock: the row-level atomicity Postgres
			// gives a single conditional UPDATE.
			f.mu.Lock()
			defer f.mu.Unlock()
			if !f.matches(r.URL.Query()) {
				w.Write([]byte("[]")) // 0 rows updated
				return
			}
			for k, v := range patch {
				f.row[k] = v
			}
			json.NewEncoder(w).Encode([]any{f.row})
		default:
			http.Error(w, `{"code":"404","message":"unexpected `+r.Method+` `+r.URL.Path+`"}`, 404)
		}
	})
}

// Two concurrent claims on one approved task: exactly one wins; the loser gets
// AlreadyClaimedError naming the winner — the race the unconditional
// UpdateActionState used to lose.
func TestClaimActionConcurrentSingleWinner(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	names := []string{"agent-a", "agent-b"}
	actions := make([]*Action, 2)
	claimErrs := make([]error, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range names {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			actions[i], _, claimErrs[i] = st.ClaimAction(context.Background(), canvasID, actionID, names[i])
		}(i)
	}
	close(start)
	wg.Wait()

	winners, losers := 0, 0
	winnerName := ""
	var loserErr error
	for i := range names {
		if claimErrs[i] == nil {
			winners++
			winnerName = names[i]
			if actions[i] == nil || actions[i].State != "executing" {
				t.Fatalf("winner %s got action %+v, want state executing", names[i], actions[i])
			}
			if actions[i].ClaimedBy == nil || *actions[i].ClaimedBy != names[i] {
				t.Fatalf("winner %s got claimedBy %v, want own name", names[i], actions[i].ClaimedBy)
			}
		} else {
			losers++
			loserErr = claimErrs[i]
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("want exactly 1 winner and 1 loser, got %d winners (errs: %v)", winners, claimErrs)
	}
	var already *AlreadyClaimedError
	if !errors.As(loserErr, &already) {
		t.Fatalf("loser error = %v, want *AlreadyClaimedError", loserErr)
	}
	if already.ClaimedBy != winnerName {
		t.Fatalf("loser told claimedBy=%q, want winner %q", already.ClaimedBy, winnerName)
	}
	if got, _ := fake.row["claimed_by"].(string); got != winnerName {
		t.Fatalf("row claimed_by=%q, want %q", got, winnerName)
	}
	if got, _ := fake.row["state"].(string); got != "executing" {
		t.Fatalf("row state=%q, want executing", got)
	}
}

// A claim on a missing action reports not-found (not already-claimed), and a
// release puts an executing task back in the queue with its claim cleared.
func TestClaimAndReleaseEdges(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()

	if _, _, err := st.ClaimAction(ctx, canvasID, uuid.New(), "agent-a"); !errors.Is(err, ErrActionNotFound) {
		t.Fatalf("claim of unknown id = %v, want ErrActionNotFound", err)
	}
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	// Same NAMED claimant retrying is idempotent, a different one conflicts.
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil {
		t.Fatalf("own-claim retry should be idempotent, got %v", err)
	}
	var already *AlreadyClaimedError
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-b"); !errors.As(err, &already) {
		t.Fatalf("rival claim = %v, want *AlreadyClaimedError", err)
	}

	released, _, err := st.ReleaseAction(ctx, canvasID, actionID)
	if err != nil {
		t.Fatalf("release failed: %v", err)
	}
	if released.State != "approved" || released.ClaimedBy != nil || released.ClaimedAt != nil {
		t.Fatalf("released action = state %q claimedBy %v claimedAt %v, want approved/nil/nil",
			released.State, released.ClaimedBy, released.ClaimedAt)
	}
	// Released task is claimable again.
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-b"); err != nil {
		t.Fatalf("re-claim after release failed: %v", err)
	}
}

// TDM-7 lazy claim expiry: an 'executing' claim older than the TTL is
// atomically taken over — two racing takeovers produce exactly one winner
// (the first restamps claimed_at to now, so the loser's `claimed_at < cutoff`
// predicate stops matching) and the loser's 409 names the NEW holder, not the
// dead one.
func TestClaimActionExpiredTakeoverSingleWinner(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	fake.row["claimed_by"] = "dead-agent"
	fake.row["claimed_at"] = time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339Nano)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key") // default TTL: 15m
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	names := []string{"agent-a", "agent-b"}
	actions := make([]*Action, 2)
	claimErrs := make([]error, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range names {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			actions[i], _, claimErrs[i] = st.ClaimAction(context.Background(), canvasID, actionID, names[i])
		}(i)
	}
	close(start)
	wg.Wait()

	winners, losers := 0, 0
	winnerName := ""
	var loserErr error
	for i := range names {
		if claimErrs[i] == nil {
			winners++
			winnerName = names[i]
			if actions[i] == nil || actions[i].State != "executing" {
				t.Fatalf("takeover winner %s got action %+v, want state executing", names[i], actions[i])
			}
			if actions[i].ClaimedBy == nil || *actions[i].ClaimedBy != names[i] {
				t.Fatalf("takeover winner %s got claimedBy %v, want own name", names[i], actions[i].ClaimedBy)
			}
		} else {
			losers++
			loserErr = claimErrs[i]
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("want exactly 1 takeover winner and 1 loser, got %d winners (errs: %v)", winners, claimErrs)
	}
	var already *AlreadyClaimedError
	if !errors.As(loserErr, &already) {
		t.Fatalf("takeover loser error = %v, want *AlreadyClaimedError", loserErr)
	}
	if already.ClaimedBy != winnerName {
		t.Fatalf("loser told claimedBy=%q, want the NEW holder %q (not the dead one)", already.ClaimedBy, winnerName)
	}
	if got, _ := fake.row["claimed_by"].(string); got != winnerName {
		t.Fatalf("row claimed_by=%q, want %q", got, winnerName)
	}
}

// A takeover restamps the claim columns: claimed_by is the new claimant and
// claimed_at is fresh (so the new claim gets a full TTL of its own, and a
// second late takeover attempt no longer matches the cutoff).
func TestClaimActionTakeoverRestampsClaim(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	fake.row["claimed_by"] = "dead-agent"
	staleAt := time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	fake.row["claimed_at"] = staleAt
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	a, _, err := st.ClaimAction(context.Background(), canvasID, actionID, "agent-b")
	if err != nil {
		t.Fatalf("takeover of expired claim failed: %v", err)
	}
	if a.State != "executing" || a.ClaimedBy == nil || *a.ClaimedBy != "agent-b" {
		t.Fatalf("takeover returned state %q claimedBy %v, want executing/agent-b", a.State, a.ClaimedBy)
	}
	if a.ClaimedAt == nil || time.Since(*a.ClaimedAt) > time.Minute {
		t.Fatalf("takeover claimed_at=%v, want a just-now timestamp (stale was %s)", a.ClaimedAt, staleAt)
	}
}

// A NON-expired executing claim still conflicts exactly as before — the TTL
// path must not weaken the live-claim guarantee.
func TestClaimActionNonExpiredStill409s(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	fake.row["claimed_by"] = "busy-agent"
	fake.row["claimed_at"] = time.Now().UTC().Add(-1 * time.Minute).Format(time.RFC3339Nano)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	var already *AlreadyClaimedError
	if _, _, err := st.ClaimAction(context.Background(), canvasID, actionID, "agent-b"); !errors.As(err, &already) {
		t.Fatalf("claim on live claim = %v, want *AlreadyClaimedError", err)
	}
	if already.ClaimedBy != "busy-agent" {
		t.Fatalf("conflict names %q, want live holder busy-agent", already.ClaimedBy)
	}
	if got, _ := fake.row["claimed_by"].(string); got != "busy-agent" {
		t.Fatalf("live claim was overwritten: claimed_by=%q", got)
	}
}

// WithClaimTTL(0) disables expiry: even an ancient claim is honored forever
// (until an explicit release), preserving the pre-TDM-7 behavior.
func TestClaimActionTTLZeroDisablesTakeover(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	fake.row["claimed_by"] = "dead-agent"
	fake.row["claimed_at"] = time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339Nano)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key", WithClaimTTL(0))
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	var already *AlreadyClaimedError
	if _, _, err := st.ClaimAction(context.Background(), canvasID, actionID, "agent-b"); !errors.As(err, &already) {
		t.Fatalf("claim with TTL=0 = %v, want *AlreadyClaimedError", err)
	}
	if already.ClaimedBy != "dead-agent" {
		t.Fatalf("conflict names %q, want dead-agent", already.ClaimedBy)
	}
	if got, _ := fake.row["claimed_by"].(string); got != "dead-agent" {
		t.Fatalf("TTL=0 still took over the claim: claimed_by=%q", got)
	}
}

// The takeover path only ever fires on 'executing' rows — done/failed/proposed
// /rejected tasks keep refusing claims even when stale claim columns linger.
func TestClaimActionTakeoverIgnoresNonExecutingStates(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "done")
	fake.row["claimed_by"] = "dead-agent"
	fake.row["claimed_at"] = time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339Nano)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	for _, state := range []string{"proposed", "done", "failed", "rejected"} {
		fake.row["state"] = state
		if _, _, err := st.ClaimAction(context.Background(), canvasID, actionID, "agent-b"); !errors.Is(err, ErrIllegalActionState) {
			t.Fatalf("claim of stale-claim %s task = %v, want ErrIllegalActionState", state, err)
		}
		if got, _ := fake.row["state"].(string); got != state {
			t.Fatalf("claim mutated %s row to state %q", state, got)
		}
	}
}

// Requeue puts a FAILED task back in the queue (failed → approved) with its
// claim AND error cleared; a retry on the now-approved task is idempotent.
func TestRequeueActionTransition(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "failed")
	fake.row["claimed_by"] = "agent-a"
	fake.row["claimed_at"] = "2026-07-27T00:00:00Z"
	fake.row["error"] = "exit status 1"
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()

	if _, _, err := st.RequeueAction(ctx, canvasID, uuid.New()); !errors.Is(err, ErrActionNotFound) {
		t.Fatalf("requeue of unknown id = %v, want ErrActionNotFound", err)
	}

	requeued, _, err := st.RequeueAction(ctx, canvasID, actionID)
	if err != nil {
		t.Fatalf("requeue failed: %v", err)
	}
	if requeued.State != "approved" || requeued.ClaimedBy != nil || requeued.ClaimedAt != nil || requeued.Error != nil {
		t.Fatalf("requeued action = state %q claimedBy %v claimedAt %v error %v, want approved/nil/nil/nil",
			requeued.State, requeued.ClaimedBy, requeued.ClaimedAt, requeued.Error)
	}
	if got, _ := fake.row["state"].(string); got != "approved" {
		t.Fatalf("row state=%q, want approved", got)
	}
	if fake.row["error"] != nil || fake.row["claimed_by"] != nil || fake.row["claimed_at"] != nil {
		t.Fatalf("row not cleared: error=%v claimed_by=%v claimed_at=%v",
			fake.row["error"], fake.row["claimed_by"], fake.row["claimed_at"])
	}

	// Idempotent retry: the task is already back in 'approved'.
	if _, _, err := st.RequeueAction(ctx, canvasID, actionID); err != nil {
		t.Fatalf("requeue retry should be idempotent, got %v", err)
	}

	// Requeued task is claimable again.
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-b"); err != nil {
		t.Fatalf("re-claim after requeue failed: %v", err)
	}
}

// Requeue only moves tasks OUT OF 'failed' — every other state is refused (the
// generic PATCH path never allows failed → approved either; the transition
// lives solely in this conditional UPDATE).
func TestRequeueActionGuardsNonFailedStates(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()

	for _, state := range []string{"proposed", "executing", "done", "rejected"} {
		fake.row["state"] = state
		if _, _, err := st.RequeueAction(ctx, canvasID, actionID); !errors.Is(err, ErrIllegalActionState) {
			t.Fatalf("requeue of %s task = %v, want ErrIllegalActionState", state, err)
		}
		if got, _ := fake.row["state"].(string); got != state {
			t.Fatalf("guard mutated row state to %q, want untouched %q", got, state)
		}
	}
}

// Epics are never claimed/executed, so they can never be requeued — refused by
// type even if a row somehow reads state 'failed'.
func TestRequeueActionRejectsEpics(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "failed")
	fake.row["type"] = "epic"
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	if _, _, err := st.RequeueAction(context.Background(), canvasID, actionID); !errors.Is(err, ErrIllegalActionState) {
		t.Fatalf("requeue of epic = %v, want ErrIllegalActionState", err)
	}
	if got, _ := fake.row["state"].(string); got != "failed" {
		t.Fatalf("epic requeue mutated state to %q", got)
	}
}

// QA wave-3 BLOCKER regression: a NAMED claimant re-claiming its own EXPIRED
// claim must RESTAMP claimed_at (self-takeover), not return the stale claim.
// Without the restamp, a long task's harness retry leaves claimed_at
// permanently past the TTL, and any rival's takeover then double-executes the
// task while the original holder is still working it.
func TestClaimActionSameClaimantExpiredReclaimRestamps(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "executing")
	fake.row["claimed_by"] = "agent-a"
	staleAt := time.Now().UTC().Add(-30 * time.Minute)
	fake.row["claimed_at"] = staleAt.Format(time.RFC3339Nano)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key") // default TTL: 15m
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}

	// The holder retries its own claim: idempotent success AND a fresh stamp.
	a, _, cerr := st.ClaimAction(context.Background(), canvasID, actionID, "agent-a")
	if cerr != nil {
		t.Fatalf("self-reclaim of expired claim errored: %v", cerr)
	}
	if a == nil || a.ClaimedBy == nil || *a.ClaimedBy != "agent-a" {
		t.Fatalf("self-reclaim returned %+v, want agent-a's claim", a)
	}
	if a.ClaimedAt == nil || !a.ClaimedAt.After(staleAt.Add(time.Minute)) {
		t.Fatalf("self-reclaim did not restamp claimed_at: got %v (stale was %v)", a.ClaimedAt, staleAt)
	}

	// A rival arriving right after must now LOSE (claim no longer expired).
	_, _, rerr := st.ClaimAction(context.Background(), canvasID, actionID, "agent-b")
	var claimed *AlreadyClaimedError
	if !errors.As(rerr, &claimed) || claimed.ClaimedBy != "agent-a" {
		t.Fatalf("rival after restamp: err = %v, want AlreadyClaimedError{agent-a}", rerr)
	}
}
