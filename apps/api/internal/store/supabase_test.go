package store

import "testing"

func TestResolveRowData(t *testing.T) {
	cols := []SheetColumn{
		{ID: "col-task", Name: "Task", Type: "text"},
		{ID: "col-done", Name: "Done", Type: "checkbox"},
	}

	tests := []struct {
		name string
		in   map[string]any
		want map[string]any
	}{
		{
			name: "exact name match",
			in:   map[string]any{"Task": "ship it", "Done": true},
			want: map[string]any{"col-task": "ship it", "col-done": true},
		},
		{
			name: "case-insensitive name match",
			in:   map[string]any{"task": "lower", "DONE": false},
			want: map[string]any{"col-task": "lower", "col-done": false},
		},
		{
			name: "column id passes through unchanged",
			in:   map[string]any{"col-task": "by id"},
			want: map[string]any{"col-task": "by id"},
		},
		{
			name: "unknown key left untouched",
			in:   map[string]any{"mystery": 1},
			want: map[string]any{"mystery": 1},
		},
		{
			name: "mixed names and ids",
			in:   map[string]any{"Task": "a", "col-done": true},
			want: map[string]any{"col-task": "a", "col-done": true},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveRowData(cols, tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("len = %d, want %d (got %v)", len(got), len(tc.want), got)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Errorf("key %q = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}

func TestResolveRowDataNoColumns(t *testing.T) {
	in := map[string]any{"anything": "value"}
	got := resolveRowData(nil, in)
	if got["anything"] != "value" {
		t.Errorf("with no columns, data should pass through unchanged, got %v", got)
	}
}
