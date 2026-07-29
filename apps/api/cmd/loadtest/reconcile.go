package main

import (
	"fmt"
	"sort"
)

// The invariant check. This is the product's core promise, so it is checked
// against BOTH sides of the run and it is checked exhaustively:
//
//	client side — every agent's own record of which tasks it won the atomic
//	              claim on, and which it drove to done;
//	server side — the final state of every task the run seeded, read back in one
//	              list after the load stops, with the claimant the server recorded.
//
// Neither side alone is proof. The client alone would miss a server that handed
// the same task to two agents and then let the second overwrite the first's
// claimedBy; the server alone would miss two agents both believing they own a
// task whose final row shows only the last writer. Requiring them to AGREE, task
// by task, is what makes "zero double-claims" a measurement rather than a
// slogan.

// serverTaskState is what the API reports for a seeded task after the run.
type serverTaskState struct {
	State     string `json:"state"`
	ClaimedBy string `json:"claimedBy"`
}

// DoubleClaim records one task that more than one agent believed it owned — the
// exact failure the product promises can never happen.
type DoubleClaim struct {
	TaskID string   `json:"task_id"`
	Agents []string `json:"agents"`
	// Kind is "claim" (two agents won the atomic claim) or "complete" (two
	// agents drove the same task to done). Either is a broken promise; they are
	// distinguished because they implicate different code.
	Kind string `json:"kind"`
}

// InvariantResult is the verdict.
type InvariantResult struct {
	// DoubleClaimFree is THE answer: did any task get claimed or completed by
	// more than one agent. It is reported separately from OK so that a run with
	// unrelated hygiene problems (an orphaned claim left by a transport error,
	// say) still gives an unambiguous verdict on the core promise.
	DoubleClaimFree bool `json:"double_claim_free"`
	// OK additionally requires state consistency: nothing left executing, every
	// done task attributable to exactly one agent, client and server agreeing on
	// who that was, and the op counts adding up.
	OK bool `json:"ok"`

	TasksSeeded    int `json:"tasks_seeded"`
	TasksDone      int `json:"tasks_done"`
	TasksApproved  int `json:"tasks_approved"`
	TasksExecuting int `json:"tasks_executing"`
	TasksOther     int `json:"tasks_other"`

	ClaimWins   int `json:"claim_wins"`
	Completions int `json:"completions"`

	DoubleClaims []DoubleClaim `json:"double_claims,omitempty"`
	Violations   []string      `json:"violations,omitempty"`
}

// checkInvariant is pure so it can be unit-tested against hand-built evidence,
// including evidence that is deliberately broken.
//
// states may be nil in tests that only exercise the client-side overlap logic.
func checkInvariant(
	seeded []string,
	claimedBy map[string][]string,
	completedBy map[string][]string,
	states map[string]serverTaskState,
	ops map[string]OpStat,
) InvariantResult {
	res := InvariantResult{DoubleClaimFree: true, OK: true, TasksSeeded: len(seeded)}
	fail := func(format string, args ...any) {
		res.OK = false
		res.Violations = append(res.Violations, fmt.Sprintf(format, args...))
	}
	doubled := func(dc DoubleClaim) {
		res.DoubleClaimFree = false
		res.OK = false
		res.DoubleClaims = append(res.DoubleClaims, dc)
	}

	seededSet := make(map[string]bool, len(seeded))
	for _, id := range seeded {
		seededSet[id] = true
	}

	// ── Overlap: which agents believe they won / finished each task ───────────
	winners := map[string][]string{}
	finishers := map[string][]string{}
	for _, agent := range sortedKeys(claimedBy) {
		for _, id := range claimedBy[agent] {
			winners[id] = append(winners[id], agent)
			res.ClaimWins++
			if !seededSet[id] {
				fail("agent %s won task %s, which this run never seeded", agent, id)
			}
		}
	}
	for _, agent := range sortedKeys(completedBy) {
		for _, id := range completedBy[agent] {
			finishers[id] = append(finishers[id], agent)
			res.Completions++
			if !containsStr(claimedBy[agent], id) {
				fail("agent %s completed task %s without ever winning its claim", agent, id)
			}
		}
	}
	for _, id := range sortedKeys(winners) {
		if len(winners[id]) > 1 {
			doubled(DoubleClaim{TaskID: id, Agents: winners[id], Kind: "claim"})
		}
	}
	for _, id := range sortedKeys(finishers) {
		if len(finishers[id]) > 1 {
			doubled(DoubleClaim{TaskID: id, Agents: finishers[id], Kind: "complete"})
		}
	}

	// ── Server side: the final state of every seeded task ─────────────────────
	for _, id := range seeded {
		if states == nil {
			continue
		}
		st, ok := states[id]
		if !ok {
			fail("task %s has no server state after the run", id)
			continue
		}
		switch st.State {
		case "done":
			res.TasksDone++
			switch len(finishers[id]) {
			case 1:
				if st.ClaimedBy != "" && st.ClaimedBy != finishers[id][0] {
					fail("task %s: server recorded claimedBy=%q but %q completed it client-side",
						id, st.ClaimedBy, finishers[id][0])
				}
			case 0:
				fail("task %s is done on the server but no agent recorded completing it", id)
			}
		case "approved":
			res.TasksApproved++
			if n := len(winners[id]); n > 0 {
				fail("task %s is back in the queue but %d agent(s) recorded winning its claim", id, n)
			}
		case "executing":
			res.TasksExecuting++
			fail("task %s was left executing (claimedBy=%q) — a claim leaked", id, st.ClaimedBy)
		default:
			res.TasksOther++
			fail("task %s ended in unexpected state %q", id, st.State)
		}
	}

	// ── Counts must add up ────────────────────────────────────────────────────
	if ops != nil {
		if got := ops[opClaim].Count; got != res.ClaimWins {
			fail("recorder counted %d winning claims but agents' win sets hold %d", got, res.ClaimWins)
		}
		if got := ops[opComplete].Count; got != res.Completions {
			fail("recorder counted %d completions but agents' completion sets hold %d", got, res.Completions)
		}
	}
	return res
}

// ── Cross-check against the server's own contention counters ──────────────────

// ClaimCrossCheck compares what the benchmark observed on the wire against what
// the server counted internally (TDM-42's claims / claim_conflicts). Two
// independent instruments measuring the same events: if they disagree, one of
// them is wrong and it matters which.
type ClaimCrossCheck struct {
	Available            bool   `json:"available"`
	ClientClaimWins      int    `json:"client_claim_wins"`
	ServerClaimsDelta    int64  `json:"server_claims_delta"`
	ClaimsAgree          bool   `json:"claims_agree"`
	ClientConflicts      int    `json:"client_conflicts"`
	ServerConflictsDelta int64  `json:"server_conflicts_delta"`
	ConflictsAgree       bool   `json:"conflicts_agree"`
	Note                 string `json:"note,omitempty"`
}

// crossCheckClaims is pure — unit tested.
func crossCheckClaims(inv InvariantResult, view ServerView, ops map[string]OpStat) ClaimCrossCheck {
	cc := ClaimCrossCheck{
		ClientClaimWins: inv.ClaimWins,
		ClientConflicts: ops[opClaimConflict].Count,
	}
	if !view.Available || !view.CountersAvailable {
		cc.Note = "server exposes no claim counters — cross-check skipped (build predates TDM-42, or metrics are disabled)"
		return cc
	}
	cc.Available = true
	cc.ServerClaimsDelta = view.ClaimsDelta
	cc.ServerConflictsDelta = view.ClaimConflictsDelta
	cc.ClaimsAgree = cc.ServerClaimsDelta == int64(cc.ClientClaimWins)
	cc.ConflictsAgree = cc.ServerConflictsDelta == int64(cc.ClientConflicts)

	switch {
	case cc.ClaimsAgree && cc.ConflictsAgree:
		cc.Note = "exact agreement: every claim and every conflict the benchmark saw on the wire was counted once by the server"
	case cc.ServerClaimsDelta > int64(cc.ClientClaimWins) || cc.ServerConflictsDelta > int64(cc.ClientConflicts):
		// The usual innocent explanation on a shared dev box.
		cc.Note = "server counted MORE than the benchmark issued — expected if anything else (a browser tab, another session) touched a queue on this server during the run"
	default:
		cc.Note = "server counted FEWER claims/conflicts than the benchmark observed on the wire — that is a real divergence and should be investigated"
	}
	return cc
}

// ── small helpers ─────────────────────────────────────────────────────────────

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func containsStr(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
