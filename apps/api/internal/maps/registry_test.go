package maps

import "testing"

func TestLoadEmbedded(t *testing.T) {
	r, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("LoadEmbedded: %v", err)
	}
	want := []string{"japan", "tokyo", "us", "world"}
	got := r.IDs()
	if len(got) != len(want) {
		t.Fatalf("IDs len = %d, want %d (%v vs %v)", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("IDs[%d] = %s, want %s", i, got[i], want[i])
		}
	}
}

func TestGetUnknown(t *testing.T) {
	r, _ := LoadEmbedded()
	if _, ok := r.Get("does-not-exist"); ok {
		t.Fatal("Get unknown should return false")
	}
}

func TestHas(t *testing.T) {
	r, _ := LoadEmbedded()
	if !r.Has("world") {
		t.Fatal("Has(world) = false")
	}
	if r.Has("nope") {
		t.Fatal("Has(nope) = true")
	}
}

func TestListShape(t *testing.T) {
	r, _ := LoadEmbedded()
	summaries := r.List()
	for _, s := range summaries {
		if s.ID == "" || s.Name == "" {
			t.Fatalf("incomplete summary: %+v", s)
		}
	}
}
