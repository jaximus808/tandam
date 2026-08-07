package api

import (
	"testing"

	"github.com/agentcanvas/api/internal/store"
	"github.com/google/uuid"
)

// TDM-5 — the epic block on the single-task read carries the epic's BODY.
//
// An epic body is where a proposer writes the contracts every ticket under the
// batch has to honour ("the gateway owns the projection", "keep the boolean").
// A worker handed one ticket has to read it to start, and before this it could
// only get there by spending a second read on the epic id — which defeats the
// point of hydrating the epic on this call at all.
//
// The helpers here (readActionEpicBlock, qualityFakeStore, qualityAction) live
// in ticket_quality_test.go: same package, same handler, one harness.

func TestReadActionAttachesEpicBody(t *testing.T) {
	canvasID := uuid.New()

	// Verbatim means verbatim: markdown, newlines and all. The body is passed
	// through as the proposer wrote it — no truncation, no reflowing.
	const body = "Contracts for this batch:\n\n- the API ships the fact, the gateway projects it\n- do NOT widen `hasLinkedContext` (TDM-168)\n"

	cases := []struct {
		name        string
		epicPayload map[string]any
		want        string
	}{
		{
			name:        "an epic with a body ships it verbatim",
			epicPayload: map[string]any{"title": "E5", "body": body},
			want:        body,
		},
		{
			// A body-less epic must still answer with the key. A missing key
			// would make the client's default the deciding vote — the same
			// reasoning that keeps hasLinkedContext always present.
			name:        "an epic with no body field reads as empty, not absent",
			epicPayload: map[string]any{"title": "E5"},
			want:        "",
		},
		{
			name:        "an epic with an empty body reads as empty",
			epicPayload: map[string]any{"title": "E5", "body": ""},
			want:        "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			epicID := uuid.New()
			taskID := uuid.New()
			s := &qualityFakeStore{byID: map[uuid.UUID]*store.Action{
				epicID: qualityAction(epicID, "epic", tc.epicPayload),
				taskID: qualityAction(taskID, "task", map[string]any{
					"title": "A ticket under the batch", "epicId": epicID.String(),
				}),
			}}

			epic := readActionEpicBlock(t, s, canvasID, taskID)
			if epic == nil {
				t.Fatal("no epic block on the read")
			}
			got, ok := epic["body"].(string)
			if !ok {
				t.Fatalf("body missing or not a string: %#v", epic["body"])
			}
			if got != tc.want {
				t.Errorf("body = %q, want %q", got, tc.want)
			}
		})
	}
}

// Adding the body must not cost the block anything it already carried — the
// ticket-quality derivation still reads hasLinkedContext off the same map, and
// title/state are what the board renders.
func TestReadActionEpicBlockKeepsItsExistingFields(t *testing.T) {
	canvasID := uuid.New()
	epicID := uuid.New()
	taskID := uuid.New()
	s := &qualityFakeStore{byID: map[uuid.UUID]*store.Action{
		epicID: qualityAction(epicID, "epic", map[string]any{
			"title": "E5", "body": "the brief", "linkedIds": []string{uuid.NewString()},
		}),
		taskID: qualityAction(taskID, "task", map[string]any{
			"title": "A ticket under the batch", "epicId": epicID.String(),
		}),
	}}

	epic := readActionEpicBlock(t, s, canvasID, taskID)
	if epic == nil {
		t.Fatal("no epic block on the read")
	}
	if got := epic["title"]; got != "E5" {
		t.Errorf("title = %#v, want %q", got, "E5")
	}
	if got := epic["state"]; got != "proposed" {
		t.Errorf("state = %#v, want %q", got, "proposed")
	}
	if got := epic["id"]; got != epicID.String() {
		t.Errorf("id = %#v, want %q", got, epicID.String())
	}
	// Still the boolean, still true. The id list stays off the wire (TDM-168).
	if got, ok := epic["hasLinkedContext"].(bool); !ok || !got {
		t.Errorf("hasLinkedContext = %#v, want true", epic["hasLinkedContext"])
	}
	if _, leaked := epic["linkedIds"]; leaked {
		t.Errorf("epic block must not ship the linked id list, got %#v", epic["linkedIds"])
	}
}
