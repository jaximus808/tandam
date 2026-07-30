package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-129: the approval gate is SERVER-enforced, not gateway-enforced. Every door
// into the ready queue — a born-approved proposal, /approve, approve-batch,
// /reject — is refused unless the server's derived provenance says a signed-in
// human. A plain canvas write-JWT (an agent asserting its own name, or an
// anonymous curl holding the 8-char code) can propose, never approve. These tests
// drive the handlers directly with each author class stamped in context, exactly
// as the Provenance middleware would.

// authoredRequest is canvasRequest with a specific server-derived author, standing
// in for what the Provenance middleware puts in context. author "" reads back as
// nil (no provenance / not a human).
func authoredRequest(t *testing.T, method, path string, body any, canvasID uuid.UUID, urlID, author string) *http.Request {
	t.Helper()
	r := canvasRequest(t, method, path, body, canvasID, urlID)
	return r.WithContext(WithAuthor(r.Context(), author))
}

// nonHumanAuthors are the caller classes that must NOT be able to approve: an
// agent asserting its own identity, an anonymous canvas-token holder, and a
// request with no derived provenance at all (safe failure = refuse).
var nonHumanAuthors = []struct {
	name   string
	author string
}{
	{"agent", authorAgentPrefix + "evil-executor"},
	{"anonymous", AuthorAnonymous},
	{"no-provenance", ""},
}

func TestBornApprovedRefusedForNonHumans(t *testing.T) {
	canvasID := uuid.New()
	for _, tc := range nonHumanAuthors {
		t.Run("single/"+tc.name, func(t *testing.T) {
			fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{}}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ProposeAction(w, authoredRequest(t, "POST", "/api/canvas/actions",
				map[string]any{"type": "task", "state": "approved", "proposedBy": "evil",
					"payload": map[string]any{"title": "sneaky"}}, canvasID, "", tc.author))
			if w.Code != http.StatusForbidden {
				t.Fatalf("born-approved by %s = %d, want 403; body %s", tc.name, w.Code, w.Body)
			}
			if len(fake.created) != 0 {
				t.Fatalf("a refused born-approved must create nothing; created %d", len(fake.created))
			}
		})
		t.Run("batch/"+tc.name, func(t *testing.T) {
			fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{}}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ProposeActionsBatch(w, authoredRequest(t, "POST", "/api/canvas/actions/batch",
				map[string]any{"actions": []map[string]any{
					{"type": "task", "payload": map[string]any{"title": "ok proposed"}},
					{"type": "task", "state": "approved", "payload": map[string]any{"title": "sneaky"}},
				}}, canvasID, "", tc.author))
			if w.Code != http.StatusForbidden {
				t.Fatalf("batch born-approved by %s = %d, want 403; body %s", tc.name, w.Code, w.Body)
			}
			// The whole batch is refused before any insert — one bad item taints it.
			if len(fake.created) != 0 {
				t.Fatalf("a refused batch must create nothing; created %d", len(fake.created))
			}
		})
	}
}

func TestApproveRefusedForNonHumans(t *testing.T) {
	canvasID := uuid.New()
	for _, tc := range nonHumanAuthors {
		t.Run(tc.name, func(t *testing.T) {
			taskID := uuid.New()
			fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{
				taskID: {ID: taskID, Type: "task", State: "proposed"},
			}}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ApproveAction(w, authoredRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/approve",
				map[string]any{"approvedBy": "human"}, canvasID, taskID.String(), tc.author))
			if w.Code != http.StatusForbidden {
				t.Fatalf("/approve by %s = %d, want 403; body %s", tc.name, w.Code, w.Body)
			}
			if st := fake.actions[taskID].State; st != "proposed" {
				t.Fatalf("refused approve left state %q, want proposed (untouched)", st)
			}
		})
	}
}

func TestApproveBatchRefusedForNonHumans(t *testing.T) {
	canvasID := uuid.New()
	for _, tc := range nonHumanAuthors {
		t.Run(tc.name, func(t *testing.T) {
			taskID := uuid.New()
			fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{
				taskID: {ID: taskID, Type: "task", State: "proposed"},
			}}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.ApproveActionsBatch(w, authoredRequest(t, "POST", "/api/canvas/actions/approve-batch",
				map[string]any{"ids": []string{taskID.String()}}, canvasID, "", tc.author))
			if w.Code != http.StatusForbidden {
				t.Fatalf("approve-batch by %s = %d, want 403; body %s", tc.name, w.Code, w.Body)
			}
			if st := fake.actions[taskID].State; st != "proposed" {
				t.Fatalf("refused approve-batch left state %q, want proposed (untouched)", st)
			}
		})
	}
}

func TestRejectRefusedForNonHumans(t *testing.T) {
	canvasID := uuid.New()
	for _, tc := range nonHumanAuthors {
		t.Run(tc.name, func(t *testing.T) {
			taskID := uuid.New()
			fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{
				taskID: {ID: taskID, Type: "task", State: "proposed"},
			}}
			h := NewHandler(fake, nil, nil)
			w := httptest.NewRecorder()
			h.RejectAction(w, authoredRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/reject",
				map[string]any{"reason": "no"}, canvasID, taskID.String(), tc.author))
			if w.Code != http.StatusForbidden {
				t.Fatalf("/reject by %s = %d, want 403; body %s", tc.name, w.Code, w.Body)
			}
			if st := fake.actions[taskID].State; st != "proposed" {
				t.Fatalf("refused reject left state %q, want proposed (untouched)", st)
			}
		})
	}
}

// The gate blocks approval, not proposal: an AGENT proposing ordinary (proposed)
// work still lands, and its provenance is stamped agent — the queue must keep
// flowing for the normal agent path.
func TestAgentCanStillPropose(t *testing.T) {
	canvasID := uuid.New()
	fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	h.ProposeAction(w, authoredRequest(t, "POST", "/api/canvas/actions",
		map[string]any{"type": "task", "payload": map[string]any{"title": "normal work"}},
		canvasID, "", authorAgentPrefix+"executor-1"))
	if w.Code != http.StatusCreated {
		t.Fatalf("agent propose = %d, want 201; body %s", w.Code, w.Body)
	}
	if len(fake.created) != 1 || fake.created[0].State != "proposed" {
		t.Fatalf("agent proposal should land 'proposed'; got %+v", fake.created)
	}
	if got := fake.created[0].AuthoredBy; got == nil || *got != authorAgentPrefix+"executor-1" {
		t.Fatalf("authoredBy = %v, want agent:executor-1", got)
	}
}

// A human approving stamps approvedBy from provenance ("human"), never from the
// body — the fabricated-stamp vector is closed even for the legitimate path.
func TestHumanApproveStampsProvenance(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	fake := &policyFakeStore{policy: "strict", actions: map[uuid.UUID]*store.Action{
		taskID: {ID: taskID, Type: "task", State: "proposed"},
	}}
	h := NewHandler(fake, nil, nil)
	w := httptest.NewRecorder()
	// Body tries to forge a different approver; it must be ignored.
	h.ApproveAction(w, authoredRequest(t, "POST", "/api/canvas/actions/"+taskID.String()+"/approve",
		map[string]any{"approvedBy": "someone-else"}, canvasID, taskID.String(), AuthorHuman))
	if w.Code != http.StatusOK {
		t.Fatalf("human approve = %d, want 200; body %s", w.Code, w.Body)
	}
	if got := fake.actions[taskID].ApprovedBy; got == nil || *got != AuthorHuman {
		t.Fatalf("approvedBy = %v, want %q (from provenance, not the body)", got, AuthorHuman)
	}
}
