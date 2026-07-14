package store

import "testing"

// Defaults are the "sane" baseline the task calls for: every content category on,
// chatty minor edits off, in-app delivery on with email/push dormant.
func TestDefaultNotificationPrefs(t *testing.T) {
	d := DefaultNotificationPrefs()
	if len(d.Categories) != len(NotifiableModes) {
		t.Fatalf("expected %d categories, got %d", len(NotifiableModes), len(d.Categories))
	}
	for _, m := range NotifiableModes {
		if !d.Categories[m] {
			t.Errorf("category %q should default on", m)
		}
	}
	if d.MinorEdits {
		t.Error("minor edits should default off")
	}
	if !d.Channels.InApp || d.Channels.Email || d.Channels.Push {
		t.Errorf("channels should default in-app only, got %+v", d.Channels)
	}
}

// Normalize drops unknown category keys and fills missing known modes with on, so
// a stored blob always round-trips to the full, junk-free set of modes.
func TestNormalizeCategories(t *testing.T) {
	p := &NotificationPrefs{
		Categories: map[string]bool{
			"docs":     false, // an explicit mute is preserved
			"gremlins": true,  // unknown key is dropped
			// "sheets" omitted → filled as on
		},
	}
	p.Normalize()

	if len(p.Categories) != len(NotifiableModes) {
		t.Fatalf("expected %d categories after normalize, got %d", len(NotifiableModes), len(p.Categories))
	}
	if _, ok := p.Categories["gremlins"]; ok {
		t.Error("unknown category should have been dropped")
	}
	if p.Categories["docs"] {
		t.Error("explicit docs=false should be preserved")
	}
	if !p.Categories["sheets"] {
		t.Error("omitted known mode should be filled as on")
	}
}
