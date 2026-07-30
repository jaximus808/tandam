package store

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TDM-98 — the fencing token, at the store layer: minted by the claim itself,
// against the fake PostgREST in claim_test.go so the real conditional-UPDATE
// sequence runs (the claim UPDATE, then the record write predicated on the exact
// lease it stamped).

// generationOf reads the stored token straight off the fake's row.
func generationOf(t *testing.T, fake *fakeActionsServer) int {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	raw, err := json.Marshal(fake.row["payload"])
	if err != nil {
		t.Fatalf("marshal stored payload: %v", err)
	}
	return ReadClaimRecord(raw).Generation
}

// A claim mints generation 1 and hands it back; the token is stored on the task
// next to its content, which is left untouched.
func TestClaimActionMintsFirstGeneration(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	a, out, err := st.ClaimAction(context.Background(), canvasID, actionID, "agent-a")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if out.ClaimGeneration != 1 {
		t.Fatalf("outcome generation = %d, want 1", out.ClaimGeneration)
	}
	if got := generationOf(t, fake); got != 1 {
		t.Fatalf("stored generation = %d, want 1", got)
	}
	// The action handed to the caller carries its own token — the API layer answers
	// the claim off this row, without a second read.
	rec := ReadClaimRecord(a.Payload)
	if rec.Generation != 1 || rec.Holder != "agent-a" {
		t.Fatalf("returned claim record = %+v, want generation 1 held by agent-a", rec)
	}
	if rec.At == "" {
		t.Error("claim record has no `at` — the record must say which lease it belongs to")
	}
	// Content is untouched: the record is additive.
	var payload map[string]any
	if err := json.Unmarshal(a.Payload, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["title"] != "one task, two claimants" {
		t.Fatalf("title = %v, want it untouched by the stamp", payload["title"])
	}
}

// The generation counts LEASES and never resets: a takeover of an expired claim
// mints the next number, and a task claimed → taken over → taken over again walks
// 1, 2, 3. A reset would eventually make an old holder's stale token verify.
func TestClaimGenerationsIncrementAcrossTakeovers(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()

	expire := func() {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.row["claimed_at"] = time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	}

	if _, out, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil || out.ClaimGeneration != 1 {
		t.Fatalf("claim 1 = gen %d, err %v; want gen 1", out.ClaimGeneration, err)
	}
	expire()
	_, out, err := st.ClaimAction(ctx, canvasID, actionID, "agent-b")
	if err != nil {
		t.Fatalf("takeover: %v", err)
	}
	if out.ClaimGeneration != 2 {
		t.Fatalf("takeover generation = %d, want 2", out.ClaimGeneration)
	}
	if out.ExpiredClaimBy != "agent-a" {
		t.Fatalf("ExpiredClaimBy = %q, want agent-a — the takeover must still report the lapse", out.ExpiredClaimBy)
	}
	expire()
	// Back to the ORIGINAL holder: the name comes full circle, the token does not.
	if _, out, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil || out.ClaimGeneration != 3 {
		t.Fatalf("re-claim by the first holder = gen %d, err %v; want gen 3", out.ClaimGeneration, err)
	}
	if got := generationOf(t, fake); got != 3 {
		t.Fatalf("stored generation = %d, want 3", got)
	}
}

// A live claimant retrying its own claim gets the SAME token back and writes
// nothing: the lease did not move, so the number must not either — a retry that
// bumped it would invalidate the token the worker is already carrying.
func TestIdempotentClaimReturnsTheStoredGeneration(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	_, out, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a")
	if err != nil {
		t.Fatalf("idempotent reclaim: %v", err)
	}
	if out.ClaimGeneration != 1 {
		t.Fatalf("idempotent reclaim generation = %d, want the stored 1", out.ClaimGeneration)
	}
	if got := generationOf(t, fake); got != 1 {
		t.Fatalf("stored generation = %d, want 1 (unchanged)", got)
	}
}

// A self-takeover after the lease lapsed IS a new lease, so it mints a new token:
// the agent is alive but its old token's writes must still be refused, and the
// response it just got carries the replacement.
func TestSelfTakeoverMintsANewGeneration(t *testing.T) {
	canvasID, actionID := uuid.New(), uuid.New()
	fake := newFakeActionsServer(canvasID, actionID, "approved")
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()

	st, err := NewSupabase(srv.URL, "test-key")
	if err != nil {
		t.Fatalf("NewSupabase: %v", err)
	}
	ctx := context.Background()
	if _, _, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a"); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	fake.mu.Lock()
	fake.row["claimed_at"] = time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	fake.mu.Unlock()

	_, out, err := st.ClaimAction(ctx, canvasID, actionID, "agent-a")
	if err != nil {
		t.Fatalf("self-takeover: %v", err)
	}
	if out.ClaimGeneration != 2 {
		t.Fatalf("self-takeover generation = %d, want 2", out.ClaimGeneration)
	}
	// Still not a handoff: no claim_expired event is owed for an agent that is
	// demonstrably alive (see ClaimOutcome).
	if out.ExpiredClaimBy != "" {
		t.Fatalf("ExpiredClaimBy = %q, want empty on a self-takeover", out.ExpiredClaimBy)
	}
}

// ── The record is server-owned ────────────────────────────────────────────────

// The payload-only write path (the content gate) replaces the caller's claim key
// with the stored one, exactly as it does for the audit log: a caller can neither
// forge a generation nor blank the one it will be fenced by.
func TestContentGateCarriesTheClaimRecord(t *testing.T) {
	stored := json.RawMessage(`{"title":"t","body":"b","claim":{"generation":4,"holder":"worker-a"}}`)
	current := &Action{Type: "task", State: "executing", Payload: stored}

	// A bookkeeping write that omits the record entirely (the web editor's shape).
	next, out, err := DecideContentUpdate(current, json.RawMessage(`{"title":"t","body":"b","links":["x"]}`), "human", time.Now().UTC())
	if err != nil {
		t.Fatalf("bookkeeping write: %v", err)
	}
	if out.Reverted {
		t.Fatal("a links-only write must not trip the approval gate")
	}
	if got := ReadClaimRecord(next).Generation; got != 4 {
		t.Fatalf("generation after an omitting write = %d, want 4 (carried, not dropped)", got)
	}

	// A write that tries to LOWER the generation, which is the interesting attack:
	// present a small number and every stale token becomes valid again.
	next, _, err = DecideContentUpdate(current,
		json.RawMessage(`{"title":"t","body":"b","claim":{"generation":1,"holder":"worker-b"}}`), "agent:worker-b", time.Now().UTC())
	if err != nil {
		t.Fatalf("forging write: %v", err)
	}
	rec := ReadClaimRecord(next)
	if rec.Generation != 4 || rec.Holder != "worker-a" {
		t.Fatalf("record after a forging write = %+v, want the stored generation 4 / worker-a", rec)
	}

	// A task that has never been claimed must not grow an empty record.
	next, _, err = DecideContentUpdate(&Action{Type: "task", State: "proposed", Payload: json.RawMessage(`{"title":"t"}`)},
		json.RawMessage(`{"title":"t","claim":{"generation":9}}`), "agent:x", time.Now().UTC())
	if err != nil {
		t.Fatalf("unclaimed write: %v", err)
	}
	var p map[string]any
	if err := json.Unmarshal(next, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if _, present := p[ClaimRecordKey]; present {
		t.Fatalf("an unclaimed task grew a claim record: %s", next)
	}
}

// CarryClaimRecord is the same rule for the OTHER payload door — the one a state
// transition writes raw.
func TestCarryClaimRecord(t *testing.T) {
	stored := json.RawMessage(`{"title":"t","claim":{"generation":7,"holder":"worker-a"}}`)

	got := CarryClaimRecord(json.RawMessage(`{"title":"t","claim":{"generation":1}}`), stored)
	if rec := ReadClaimRecord(got); rec.Generation != 7 || rec.Holder != "worker-a" {
		t.Fatalf("record = %+v, want generation 7 / worker-a", rec)
	}
	got = CarryClaimRecord(json.RawMessage(`{"title":"t"}`), stored)
	if rec := ReadClaimRecord(got); rec.Generation != 7 {
		t.Fatalf("omitted record was not carried: %s", got)
	}
	// No stored record → the caller's is dropped, not kept.
	got = CarryClaimRecord(json.RawMessage(`{"title":"t","claim":{"generation":5}}`), json.RawMessage(`{"title":"t"}`))
	if rec := ReadClaimRecord(got); rec.Generation != 0 {
		t.Fatalf("a caller's record survived onto an unclaimed task: %s", got)
	}
	// Nothing to do → the payload is returned untouched (byte-identical), so this
	// never churns a payload it has no reason to rewrite.
	in := json.RawMessage(`{"title":"t"}`)
	if got := CarryClaimRecord(in, json.RawMessage(`{"title":"t"}`)); string(got) != string(in) {
		t.Fatalf("payload was rewritten with nothing to change: %s", got)
	}
	// Unparsable input is passed through rather than mangled.
	bad := json.RawMessage(`not json`)
	if got := CarryClaimRecord(bad, stored); string(got) != string(bad) {
		t.Fatalf("unparsable payload = %s, want it untouched", got)
	}
}

// ReadClaimRecord must never fail a write: everything odd reads as "no token",
// which degrades to the holder-identity check.
func TestReadClaimRecordTolerance(t *testing.T) {
	for name, raw := range map[string]string{
		"empty":            ``,
		"not an object":    `[1,2]`,
		"no claim key":     `{"title":"t"}`,
		"claim not object": `{"claim":"nope"}`,
		"negative":         `{"claim":{"generation":-2}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if got := ReadClaimRecord(json.RawMessage(raw)).Generation; got != 0 {
				t.Fatalf("generation = %d, want 0", got)
			}
		})
	}
	if got := ReadClaimRecord(json.RawMessage(`{"claim":{"generation":12,"holder":"w"}}`)); got.Generation != 12 || got.Holder != "w" {
		t.Fatalf("record = %+v, want generation 12 / w", got)
	}
}
