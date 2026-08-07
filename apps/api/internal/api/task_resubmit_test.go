package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-3 — the author's answer to a rejection
// (POST /api/canvas/actions/{id}/resubmit).
//
// What these tests are FOR, in priority order:
//
//  1. THE GATE HOLDS. A resubmit lands in 'proposed' and NOWHERE else: it hands
//     an agent a rewind, not a way into the ready queue. TestResubmitAlwaysLands
//     AtTheGate walks it, and TestResubmitWrongState proves the only state it
//     acts on is 'rejected'.
//  2. AUTHORSHIP IS THE GATE, decided from server-derived provenance and never
//     from the body. An agent brings back its OWN rejected work; everything the
//     server cannot attribute — anonymous, no provenance, no recorded author,
//     somebody else's ticket — fails CLOSED.
//  3. THE REJECTION REASON SURVIVES. The write clears actions.error, so the
//     verdict this attempt answers only exists afterwards because the audit entry
//     carried it. If that stops being true, the loop quietly loses its feedback.
//  4. The amendment is a MERGE, and a caller cannot smuggle a forged audit trail
//     through it.

// ── Fixtures ─────────────────────────────────────────────────────────────────

// resubmitFakeStore models the real ResubmitAction: predicated on
// (state='rejected', type='task'), clearing exactly what the store clears, and
// appending the entry to the STORED history in the same write.
type resubmitFakeStore struct {
	store.Store
	mu        sync.Mutex
	actions   map[uuid.UUID]*store.Action
	resubmits int
	audits    []store.ContentAudit
}

func newResubmitStore(actions ...*store.Action) *resubmitFakeStore {
	f := &resubmitFakeStore{actions: map[uuid.UUID]*store.Action{}}
	for _, a := range actions {
		f.actions[a.ID] = a
	}
	return f
}

func (f *resubmitFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, store.ErrActionNotFound
	}
	cp := *a
	return &cp, nil
}

func (f *resubmitFakeStore) ResubmitAction(_ context.Context, _ uuid.UUID, id uuid.UUID,
	payload json.RawMessage, entry store.ContentAudit) (*store.Action, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		return nil, 0, store.ErrActionNotFound
	}
	if a.Type != "task" {
		return nil, 0, fmt.Errorf("%w: only tasks can be resubmitted (this is a %q)",
			store.ErrIllegalActionState, a.Type)
	}
	if a.State != "rejected" {
		return nil, 0, fmt.Errorf("%w: only a rejected task can be resubmitted (it is %q now)",
			store.ErrIllegalActionState, a.State)
	}
	f.resubmits++
	f.audits = append(f.audits, entry)
	base := payload
	if len(base) == 0 {
		base = a.Payload
	}
	// The server-owned half, as carryContentAudit does it: the prior entries come
	// off the STORED row, whatever the incoming payload claimed.
	var p map[string]any
	if err := json.Unmarshal(base, &p); err != nil {
		return nil, 0, err
	}
	history := append(readActionAudit(a.Payload), entry)
	p["audit"] = history
	next, err := json.Marshal(p)
	if err != nil {
		return nil, 0, err
	}
	a.Payload = next
	a.State = "proposed"
	a.ApprovedBy, a.ClaimedBy, a.ClaimedAt, a.Result, a.Error = nil, nil, nil, nil, nil
	cp := *a
	return &cp, 1, nil
}

// GetCanvasState backs the async post-write broadcast; erroring makes it a no-op.
func (f *resubmitFakeStore) GetCanvasState(_ context.Context, _ uuid.UUID) (*store.Canvas, *store.CanvasState, []*store.PendingEdit, error) {
	return nil, nil, nil, fmt.Errorf("no state in this fake")
}

func (f *resubmitFakeStore) get(t *testing.T, id uuid.UUID) *store.Action {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.actions[id]
	if !ok {
		t.Fatalf("action %s vanished from the fake", id)
	}
	cp := *a
	return &cp
}

func (f *resubmitFakeStore) lastAudit(t *testing.T) store.ContentAudit {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.audits) == 0 {
		t.Fatalf("no audit entry recorded — the resubmit left no trail")
	}
	return f.audits[len(f.audits)-1]
}

func (f *resubmitFakeStore) resubmitCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.resubmits
}

// resubmitTask is a ticket as its author finds it after a human said no: the
// reason in `error`, the approval stamp gone, provenance naming the agent.
func resubmitTask(author string, reason string) *store.Action {
	a := &store.Action{
		ID: uuid.New(), Kind: "action", Type: "task", State: "rejected", Ticket: ptr(3),
		Payload: json.RawMessage(
			`{"title":"API: agent resubmit endpoint","body":"the original scope","assignee":"agent"}`),
		AuthoredBy: ptr(author),
		ProposedBy: "agent",
	}
	if reason != "" {
		a.Error = ptr(reason)
	}
	return a
}

func resubmitRequest(t *testing.T, canvasID, id uuid.UUID, body any, author string) *http.Request {
	t.Helper()
	r := canvasRequest(t, "POST", "/api/canvas/actions/"+id.String()+"/resubmit", body, canvasID, id.String())
	return withAgentAuthor(r, author)
}

func resubmitJSON(t *testing.T, h *Handler, canvasID, id uuid.UUID, body any, author string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	h.ResubmitAction(w, resubmitRequest(t, canvasID, id, body, author))
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response (%d %s): %v", w.Code, w.Body.String(), err)
	}
	return w, out
}

// ── 1. The pure authorship rule ──────────────────────────────────────────────

func TestResubmitRefusal(t *testing.T) {
	tests := []struct {
		name     string
		caller   string
		target   *store.Action
		wantCode string // "" = allowed
	}{
		{"the author brings back its own ticket", "agent:planner-a",
			resubmitTask("agent:planner-a", "too broad"), ""},
		{"another agent may not", "agent:planner-b",
			resubmitTask("agent:planner-a", "too broad"), "resubmit_not_author"},
		{"a human is not the agent author", AuthorHuman,
			resubmitTask("agent:planner-a", "too broad"), "resubmit_not_author"},
		// A human-authored ticket resubmitted by that human is the same rule, not
		// an exception: the identities match.
		{"a human's own ticket", AuthorHuman, resubmitTask(AuthorHuman, "no"), ""},
		// Anonymous is the ABSENCE of an identity: matching it against itself would
		// hand every viewer of a public canvas the author's verb.
		{"anonymous cannot resubmit even its own", AuthorAnonymous,
			resubmitTask(AuthorAnonymous, "no"), "resubmit_not_author"},
		{"no provenance at all fails closed", "",
			resubmitTask("agent:planner-a", "no"), "resubmit_not_author"},
		{"unrecorded author fails closed", "agent:planner-a",
			&store.Action{ID: uuid.New(), Type: "task", State: "rejected"}, "resubmit_not_author"},
		{"blank author fails closed", "agent:planner-a",
			&store.Action{ID: uuid.New(), Type: "task", State: "rejected", AuthoredBy: ptr("  ")}, "resubmit_not_author"},
		{"an epic is not a ticket", "agent:planner-a",
			&store.Action{ID: uuid.New(), Type: "epic", State: "rejected", AuthoredBy: ptr("agent:planner-a")},
			"resubmit_not_author"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resubmitRefusal(tc.caller, tc.target)
			switch {
			case tc.wantCode == "" && got != nil:
				t.Fatalf("refused with %q (%s), want allowed", got.code, got.message)
			case tc.wantCode != "" && got == nil:
				t.Fatalf("allowed, want refusal %q", tc.wantCode)
			case tc.wantCode != "" && got.code != tc.wantCode:
				t.Fatalf("refusal code = %q, want %q", got.code, tc.wantCode)
			}
		})
	}
}

// ── 2. The acceptance case ───────────────────────────────────────────────────

// THE POINT OF THE FEATURE: the author amends its rejected ticket and asks
// again. It lands at the gate — same ticket, same ref — with the claim and the
// approval stamp cleared, and the trail carries both the author's note and the
// rejection reason the write just cleared out of `error`.
func TestResubmitByAuthorLandsAtTheGate(t *testing.T) {
	canvasID := uuid.New()
	reason := "this is three tickets in a trench coat — split the migration out and re-propose the API change alone"
	task := resubmitTask("agent:planner-a", reason)
	task.ApprovedBy, task.ClaimedBy = ptr("human"), ptr("worker-1")
	f := newResubmitStore(task)
	h := NewHandler(f, nil, nil)

	note := "split as asked: this ticket is the API endpoint only, the migration moved to its own ticket"
	w, body := resubmitJSON(t, h, canvasID, task.ID, map[string]any{
		"note":    note,
		"payload": map[string]any{"body": "the narrowed scope: endpoint only"},
	}, "agent:planner-a")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if body["resubmitted"] != true || body["from"] != "rejected" || body["to"] != "proposed" {
		t.Fatalf("answer = %v, want resubmitted:true rejected → proposed", body)
	}

	got := f.get(t, task.ID)
	if got.State != "proposed" {
		t.Fatalf("state = %q, want proposed (behind the human gate, never approved)", got.State)
	}
	if got.ApprovedBy != nil {
		t.Fatalf("approvedBy = %q, want cleared — a ticket at the gate must not render as approved", *got.ApprovedBy)
	}
	if got.ClaimedBy != nil {
		t.Fatalf("claimedBy = %q, want cleared", *got.ClaimedBy)
	}
	if got.Error != nil {
		t.Fatalf("error = %q, want cleared — the ticket is no longer rejected", *got.Error)
	}
	if n := f.resubmitCount(); n != 1 {
		t.Fatalf("ResubmitAction called %d times, want 1", n)
	}

	// The amendment merged: the new body landed, the untouched title survived.
	var payload map[string]any
	if err := json.Unmarshal(got.Payload, &payload); err != nil {
		t.Fatalf("stored payload: %v", err)
	}
	if payload["body"] != "the narrowed scope: endpoint only" {
		t.Fatalf("body = %v, want the amendment", payload["body"])
	}
	if payload["title"] != "API: agent resubmit endpoint" {
		t.Fatalf("title = %v, want the stored title (a partial payload must not delete what it omits)", payload["title"])
	}

	entry := f.lastAudit(t)
	if entry.Actor != "agent:planner-a" {
		t.Fatalf("audit actor = %q, want agent:planner-a (the server-derived author)", entry.Actor)
	}
	if entry.FromState != "rejected" || entry.ToState != "proposed" {
		t.Fatalf("audit states = %q → %q, want rejected → proposed", entry.FromState, entry.ToState)
	}
	if !strings.Contains(entry.Note, note) {
		t.Fatalf("audit note = %q, want the author's note verbatim", entry.Note)
	}
	// THE ONE THAT MATTERS: `error` is gone, so this entry is the only surviving
	// copy of what the human said no to.
	if !strings.Contains(entry.Note, reason) {
		t.Fatalf("audit note = %q, want the rejection reason preserved — clearing error must not destroy it", entry.Note)
	}
}

// A resubmit with no payload is "I am asking again": the content is untouched,
// and the note still has to say something.
func TestResubmitWithoutPayloadKeepsContent(t *testing.T) {
	canvasID := uuid.New()
	task := resubmitTask("agent:planner-a", "not now")
	before := string(task.Payload)
	f := newResubmitStore(task)
	h := NewHandler(f, nil, nil)

	w, _ := resubmitJSON(t, h, canvasID, task.ID,
		map[string]any{"note": "nothing changed; the blocker you named is now fixed"}, "agent:planner-a")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	got := f.get(t, task.ID)
	var stored, original map[string]any
	if err := json.Unmarshal(got.Payload, &stored); err != nil {
		t.Fatalf("stored payload: %v", err)
	}
	if err := json.Unmarshal([]byte(before), &original); err != nil {
		t.Fatalf("original payload: %v", err)
	}
	for k, v := range original {
		if fmt.Sprint(stored[k]) != fmt.Sprint(v) {
			t.Fatalf("payload[%q] = %v, want %v (an empty amendment must change nothing)", k, stored[k], v)
		}
	}
}

// ── 3. The refusals, one test each ───────────────────────────────────────────

// resubmit_note_required: the whole cost of the feature is one sentence.
func TestResubmitNoteRequired(t *testing.T) {
	for _, body := range []map[string]any{
		{},
		{"note": ""},
		{"note": "   \n\t "},
		{"payload": map[string]any{"body": "changed, but silently"}},
	} {
		canvasID := uuid.New()
		task := resubmitTask("agent:planner-a", "too broad")
		f := newResubmitStore(task)
		h := NewHandler(f, nil, nil)

		w, out := resubmitJSON(t, h, canvasID, task.ID, body, "agent:planner-a")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %v: status = %d, want 400", body, w.Code)
		}
		if out["error"] != "resubmit_note_required" {
			t.Fatalf("body %v: error = %v, want resubmit_note_required", body, out["error"])
		}
		if got := f.get(t, task.ID).State; got != "rejected" {
			t.Fatalf("body %v: state = %q — a refused resubmit must not write", body, got)
		}
		if n := f.resubmitCount(); n != 0 {
			t.Fatalf("body %v: ResubmitAction called %d times, want 0", body, n)
		}
	}
}

// resubmit_not_author: somebody else's rejected ticket is not yours to revive.
func TestResubmitNotAuthorRefused(t *testing.T) {
	for _, caller := range []string{"agent:planner-b", AuthorHuman, AuthorAnonymous, ""} {
		t.Run("caller="+caller, func(t *testing.T) {
			canvasID := uuid.New()
			task := resubmitTask("agent:planner-a", "too broad")
			f := newResubmitStore(task)
			h := NewHandler(f, nil, nil)

			w, out := resubmitJSON(t, h, canvasID, task.ID,
				map[string]any{"note": "I fixed it"}, caller)
			if w.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
			}
			if out["error"] != "resubmit_not_author" {
				t.Fatalf("error = %v, want resubmit_not_author", out["error"])
			}
			if got := f.get(t, task.ID).State; got != "rejected" {
				t.Fatalf("state = %q — a refused resubmit must not write", got)
			}
			if n := f.resubmitCount(); n != 0 {
				t.Fatalf("ResubmitAction called %d times, want 0", n)
			}
		})
	}
}

// resubmit_wrong_state: 'rejected' is the only state this door acts on, and the
// refusal names the state so a client on a stale board can re-render.
func TestResubmitWrongState(t *testing.T) {
	for _, state := range []string{"proposed", "approved", "executing", "done", "failed"} {
		t.Run(state, func(t *testing.T) {
			canvasID := uuid.New()
			task := resubmitTask("agent:planner-a", "")
			task.State = state
			f := newResubmitStore(task)
			h := NewHandler(f, nil, nil)

			w, out := resubmitJSON(t, h, canvasID, task.ID,
				map[string]any{"note": "asking again"}, "agent:planner-a")
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", w.Code, w.Body.String())
			}
			if out["error"] != "resubmit_wrong_state" {
				t.Fatalf("error = %v, want resubmit_wrong_state", out["error"])
			}
			if out["state"] != state {
				t.Fatalf("state in the refusal = %v, want %q", out["state"], state)
			}
			if got := f.get(t, task.ID).State; got != state {
				t.Fatalf("state = %q, want %q — nothing must have moved", got, state)
			}
		})
	}
}

// task_not_found: an id (or an unresolved ticket ref) that names nothing here.
func TestResubmitTaskNotFound(t *testing.T) {
	canvasID := uuid.New()
	f := newResubmitStore()
	h := NewHandler(f, nil, nil)

	w, out := resubmitJSON(t, h, canvasID, uuid.New(),
		map[string]any{"note": "asking again"}, "agent:planner-a")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", w.Code, w.Body.String())
	}
	if out["error"] != "task_not_found" {
		t.Fatalf("error = %v, want task_not_found", out["error"])
	}

	// A ref that resolved to nothing arrives unparsable, and answers the same way
	// rather than "invalid id" — the ref names no ticket, which is a 404.
	w2 := httptest.NewRecorder()
	r := canvasRequest(t, "POST", "/api/canvas/actions/TDM-9999/resubmit",
		map[string]any{"note": "asking again"}, canvasID, "TDM-9999")
	h.ResubmitAction(w2, withAgentAuthor(r, "agent:planner-a"))
	if w2.Code != http.StatusNotFound {
		t.Fatalf("unresolved ref: status = %d, want 404 (body %s)", w2.Code, w2.Body.String())
	}
	if code := errorCode(t, w2); code != "task_not_found" {
		t.Fatalf("unresolved ref: error = %q, want task_not_found", code)
	}
}

// ── 4. The properties that must not rot ──────────────────────────────────────

// THE FORGERY TEST: nothing in the body buys an identity. A request that says
// every flattering thing about itself is still judged on the server-derived
// author, which here is a different agent — so it is refused.
func TestResubmitIgnoresRequestBodyIdentity(t *testing.T) {
	canvasID := uuid.New()
	task := resubmitTask("agent:planner-a", "too broad")
	f := newResubmitStore(task)
	h := NewHandler(f, nil, nil)

	w, out := resubmitJSON(t, h, canvasID, task.ID, map[string]any{
		"note":       "I definitely wrote this ticket",
		"authoredBy": "agent:planner-a", "proposedBy": "agent:planner-a",
		"agent": "planner-a", "agentName": "planner-a", "caller": "agent:planner-a",
	}, "agent:planner-b")
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 — the body must not buy authorship (body %s)", w.Code, w.Body.String())
	}
	if out["error"] != "resubmit_not_author" {
		t.Fatalf("error = %v, want resubmit_not_author", out["error"])
	}
}

// An amendment may not author the server-owned audit log. The forged entry must
// not survive into the stored payload — the real store carries the history off
// the row, and the merge drops the key before validation ever sees it.
func TestResubmitAmendmentCannotForgeAudit(t *testing.T) {
	canvasID := uuid.New()
	task := resubmitTask("agent:planner-a", "too broad")
	f := newResubmitStore(task)
	h := NewHandler(f, nil, nil)

	w, _ := resubmitJSON(t, h, canvasID, task.ID, map[string]any{
		"note": "amended",
		"payload": map[string]any{
			"body": "the amendment",
			"audit": []map[string]any{{
				"actor": "human", "fromState": "proposed", "toState": "approved",
				"summary": "approved by a person who never saw this",
			}},
			"claim": map[string]any{"generation": 99},
		},
	}, "agent:planner-a")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	trail := readActionAudit(f.get(t, task.ID).Payload)
	if len(trail) != 1 {
		t.Fatalf("audit = %+v, want exactly one entry — the caller's forged one must not survive", trail)
	}
	if trail[0].Actor != "agent:planner-a" || trail[0].ToState != "proposed" {
		t.Fatalf("audit[0] = %+v, want the server's own rejected → proposed entry", trail[0])
	}
}

// The amendment is validated as a whole ticket: a patch that empties the title
// is a 400, not a nameless card at the gate.
func TestResubmitAmendmentMustStayValid(t *testing.T) {
	for _, patch := range []any{
		map[string]any{"title": ""},
		map[string]any{"title": nil},
		map[string]any{"assignee": "nobody"},
		"not an object",
	} {
		canvasID := uuid.New()
		task := resubmitTask("agent:planner-a", "too broad")
		f := newResubmitStore(task)
		h := NewHandler(f, nil, nil)

		w, _ := resubmitJSON(t, h, canvasID, task.ID,
			map[string]any{"note": "amended", "payload": patch}, "agent:planner-a")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("patch %v: status = %d, want 400 (body %s)", patch, w.Code, w.Body.String())
		}
		if got := f.get(t, task.ID).State; got != "rejected" {
			t.Fatalf("patch %v: state = %q — an invalid amendment must not write", patch, got)
		}
	}
}

// The merge rules, on their own: absent keys survive, an explicit null deletes,
// server-owned keys are dropped.
func TestMergeTaskPayload(t *testing.T) {
	stored := json.RawMessage(`{"title":"t","body":"b","epicId":"e","assignee":"agent"}`)

	if got, err := mergeTaskPayload(stored, nil); err != nil || string(got) != string(stored) {
		t.Fatalf("empty patch = %s, %v — want the stored payload byte for byte", got, err)
	}

	got, err := mergeTaskPayload(stored, json.RawMessage(
		`{"body":"new","epicId":null,"audit":[{"actor":"human"}],"claim":{"generation":9}}`))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	var p map[string]any
	if err := json.Unmarshal(got, &p); err != nil {
		t.Fatalf("merged payload: %v", err)
	}
	if p["title"] != "t" {
		t.Fatalf("title = %v, want the stored value (an omitted key is untouched)", p["title"])
	}
	if p["body"] != "new" {
		t.Fatalf("body = %v, want the patch's value", p["body"])
	}
	if _, present := p["epicId"]; present {
		t.Fatalf("epicId survived a null — an explicit null is the only way to clear a field")
	}
	for _, k := range []string{"audit", "claim", "contention"} {
		if _, present := p[k]; present {
			t.Fatalf("server-owned key %q came in off the caller's patch", k)
		}
	}

	if _, err := mergeTaskPayload(stored, json.RawMessage(`"not an object"`)); err == nil {
		t.Fatal("a non-object patch merged without complaint")
	}
}

// The note bar is the reviewer's bar. If one moves, this says so out loud rather
// than letting the two doors drift into different ideas of what "say why" costs.
func TestResubmitNoteBarMatchesRework(t *testing.T) {
	if resubmitMinNote != reworkMinReason {
		t.Fatalf("resubmitMinNote = %d, reworkMinReason = %d — the two doors must ask the same of a caller",
			resubmitMinNote, reworkMinReason)
	}
}
