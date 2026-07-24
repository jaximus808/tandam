package api

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// The map-batch handler resolves an event's client-side pin handles against the
// pins created in the same request. resolvePinClientRef is the atom that does
// it; these cover the hit and the miss (the agent-facing error path).
func TestResolvePinClientRef_Hit(t *testing.T) {
	want := uuid.New()
	clientToPin := map[string]uuid.UUID{"hotel": want, "museum": uuid.New()}

	got, err := resolvePinClientRef(clientToPin, "hotel", "fromClientId", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Fatalf("resolved wrong pin: got %s want %s", got, want)
	}
}

func TestResolvePinClientRef_Miss(t *testing.T) {
	clientToPin := map[string]uuid.UUID{"hotel": uuid.New()}

	_, err := resolvePinClientRef(clientToPin, "nope", "clientPinId", 3)
	if err == nil {
		t.Fatalf("expected an error for an undeclared clientId")
	}
	// The message must name the offending ref, its field, and the event index
	// so the agent can fix the exact spot.
	msg := err.Error()
	for _, want := range []string{"events[3]", "clientPinId", `"nope"`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q missing %q", msg, want)
		}
	}
}

// An empty map (no pins declared, or a pins-less events-only batch) misses every
// ref rather than panicking.
func TestResolvePinClientRef_EmptyMap(t *testing.T) {
	if _, err := resolvePinClientRef(map[string]uuid.UUID{}, "p1", "toClientId", 0); err == nil {
		t.Fatalf("expected miss against an empty clientId map")
	}
	if _, err := resolvePinClientRef(nil, "p1", "toClientId", 0); err == nil {
		t.Fatalf("expected miss against a nil clientId map")
	}
}
