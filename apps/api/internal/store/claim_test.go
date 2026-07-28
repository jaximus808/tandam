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

// matches applies PostgREST eq. filters from the query string to the row.
func (f *fakeActionsServer) matches(q map[string][]string) bool {
	for key, vals := range q {
		if key == "select" || len(vals) == 0 {
			continue
		}
		want, ok := strings.CutPrefix(vals[0], "eq.")
		if !ok {
			continue // non-eq operators aren't used by the claim path
		}
		if got, _ := f.row[key].(string); got != want {
			return false
		}
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
