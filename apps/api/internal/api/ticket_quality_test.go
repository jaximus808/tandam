package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentcanvas/api/internal/auth"
	"github.com/agentcanvas/api/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// TDM-168 — the API's ONE contribution to ticket quality: the fact a read-time
// derivation cannot get anywhere else.
//
// The quality RULES are not here and are not in Go at all; see the decision
// recorded in apps/mcp-gateway/src/facade.ts. What the API owes a reader is the
// batch's link state: context linked once on the EPIC covers every ticket under
// it, so a heavy body under a linked epic is not "context pasted instead of
// linked" — and a caller holding only the task cannot tell. Without this on the
// single-task read, the read-time derivation would warn on tickets the propose
// call deliberately did not.

// qualityFakeStore serves one task and one epic, and nothing else.
type qualityFakeStore struct {
	store.Store
	byID map[uuid.UUID]*store.Action
}

func (f *qualityFakeStore) GetAction(_ context.Context, _ uuid.UUID, id uuid.UUID) (*store.Action, error) {
	if a, ok := f.byID[id]; ok {
		return a, nil
	}
	return nil, store.ErrActionNotFound
}

func (f *qualityFakeStore) GetLinkedEntities(_ context.Context, _ uuid.UUID, _ []uuid.UUID) ([]store.TaskLink, error) {
	return nil, nil
}

func qualityAction(id uuid.UUID, typ string, payload map[string]any) *store.Action {
	raw, _ := json.Marshal(payload)
	return &store.Action{ID: id, Kind: "action", Type: typ, State: "proposed", Payload: raw}
}

// readActionEpicBlock runs GET /api/canvas/actions/{id} against the handler and
// returns the hydrated `epic` block (nil when the response carried none).
func readActionEpicBlock(t *testing.T, s store.Store, canvasID, taskID uuid.UUID) map[string]any {
	t.Helper()
	h := &Handler{store: s}
	r := chi.NewRouter()
	r.Get("/api/canvas/actions/{id}", func(w http.ResponseWriter, req *http.Request) {
		ctx := context.WithValue(req.Context(), claimsKey, &auth.Claims{CanvasID: canvasID, Role: "read"})
		h.ReadAction(w, req.WithContext(ctx))
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/canvas/actions/"+taskID.String(), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("ReadAction: status %d, body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Epic map[string]any `json:"epic"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body.Epic
}

func TestReadActionReportsEpicLinkedContext(t *testing.T) {
	canvasID := uuid.New()

	cases := []struct {
		name        string
		epicPayload map[string]any
		want        bool
	}{
		{
			// The batch links the shared note: every ticket under it has its
			// context one hydrated link away, whatever its own body looks like.
			name:        "an epic that links context says so",
			epicPayload: map[string]any{"title": "E22", "linkedIds": []string{uuid.NewString()}},
			want:        true,
		},
		{
			// An empty list is not a missing field: it means the proposer linked
			// nothing, and a heavy ticket under it really did paste its context.
			name:        "an epic with an empty link list reports false",
			epicPayload: map[string]any{"title": "E22", "linkedIds": []string{}},
			want:        false,
		},
		{
			// Epics proposed before linkedIds was ever written carry no field at
			// all. They must read as "links nothing" rather than as absent — a
			// missing key would make the client's default the deciding vote.
			name:        "an epic with no linkedIds field at all reports false",
			epicPayload: map[string]any{"title": "E22"},
			want:        false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			epicID := uuid.New()
			taskID := uuid.New()
			s := &qualityFakeStore{byID: map[uuid.UUID]*store.Action{
				epicID: qualityAction(epicID, "epic", tc.epicPayload),
				taskID: qualityAction(taskID, "task", map[string]any{
					"title": "Wire the derivation", "epicId": epicID.String(),
				}),
			}}

			epic := readActionEpicBlock(t, s, canvasID, taskID)
			if epic == nil {
				t.Fatal("no epic block on the read")
			}
			got, ok := epic["hasLinkedContext"].(bool)
			if !ok {
				t.Fatalf("hasLinkedContext missing or not a bool: %#v", epic["hasLinkedContext"])
			}
			if got != tc.want {
				t.Errorf("hasLinkedContext = %v, want %v", got, tc.want)
			}
		})
	}
}

// A task with no epic is the case a stored propose-time warning could never
// have covered and this one has to: a ticket filed on its own with
// task_propose. The read must still answer, with no epic block — the derivation
// then treats the batch as linking nothing, which is the truth.
func TestReadActionUnepicedTaskHasNoEpicBlock(t *testing.T) {
	canvasID := uuid.New()
	taskID := uuid.New()
	s := &qualityFakeStore{byID: map[uuid.UUID]*store.Action{
		taskID: qualityAction(taskID, "task", map[string]any{"title": "A one-off ticket"}),
	}}

	if epic := readActionEpicBlock(t, s, canvasID, taskID); epic != nil {
		t.Errorf("a task with no epic must not carry an epic block, got %#v", epic)
	}
}
