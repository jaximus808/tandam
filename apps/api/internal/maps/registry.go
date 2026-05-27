// Package maps loads map preset definitions from JSON assets and serves them
// to API handlers. Presets are embedded in the binary at build time and loaded
// once at startup.
package maps

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"
)

//go:embed assets/*.json
var embedded embed.FS

// Layer is a single rendered layer in a map preset. The discriminator is `kind`;
// v1 only handles "tile", but the type is open so future presets can declare
// "geojson" layers without a schema change.
type Layer struct {
	Kind        string                 `json:"kind"`
	URL         string                 `json:"url,omitempty"`
	Attribution string                 `json:"attribution,omitempty"`
	MinZoom     *int                   `json:"minZoom,omitempty"`
	MaxZoom     *int                   `json:"maxZoom,omitempty"`
	Style       map[string]interface{} `json:"style,omitempty"`
}

type Definition struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Category    string          `json:"category,omitempty"`
	Tags        []string        `json:"tags,omitempty"`
	Center      [2]float64      `json:"center"`
	Zoom        int             `json:"zoom"`
	MinZoom     *int            `json:"minZoom,omitempty"`
	MaxZoom     *int            `json:"maxZoom,omitempty"`
	Bounds      *[2][2]float64  `json:"bounds,omitempty"`
	Layers      []Layer         `json:"layers"`
	Thumbnail   string          `json:"thumbnail,omitempty"`
}

type Summary struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Category    string   `json:"category,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Thumbnail   string   `json:"thumbnail,omitempty"`
}

type Registry struct {
	mu    sync.RWMutex
	byID  map[string]Definition
	order []string
}

func (r *Registry) Get(id string) (Definition, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.byID[id]
	return d, ok
}

func (r *Registry) Has(id string) bool {
	_, ok := r.Get(id)
	return ok
}

func (r *Registry) List() []Summary {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Summary, 0, len(r.order))
	for _, id := range r.order {
		d := r.byID[id]
		out = append(out, Summary{
			ID: d.ID, Name: d.Name, Description: d.Description,
			Category: d.Category, Tags: d.Tags, Thumbnail: d.Thumbnail,
		})
	}
	return out
}

// IDs returns the registered preset ids in load order.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// LoadEmbedded loads presets bundled into the binary at build time.
func LoadEmbedded() (*Registry, error) {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		return nil, err
	}
	return loadFromFS(sub)
}

// LoadFromDir loads presets from a directory on disk. Used in dev for
// hot-reload-friendly workflows.
func LoadFromDir(dir string) (*Registry, error) {
	return loadFromFS(dirFS(dir))
}

func loadFromFS(fsys fs.FS) (*Registry, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, err
	}
	r := &Registry{byID: map[string]Definition{}}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		var def Definition
		if err := json.Unmarshal(data, &def); err != nil {
			return nil, fmt.Errorf("decode %s: %w", e.Name(), err)
		}
		expectedID := strings.TrimSuffix(e.Name(), ".json")
		if def.ID != expectedID {
			return nil, fmt.Errorf("%s: id %q must match filename", e.Name(), def.ID)
		}
		if _, dup := r.byID[def.ID]; dup {
			return nil, fmt.Errorf("duplicate map id: %s", def.ID)
		}
		if len(def.Layers) == 0 {
			return nil, fmt.Errorf("%s: at least one layer required", def.ID)
		}
		r.byID[def.ID] = def
		r.order = append(r.order, def.ID)
	}
	if len(r.order) == 0 {
		return nil, errors.New("no map presets loaded")
	}
	// Stable order across runs (load order isn't guaranteed by fs.ReadDir).
	sort.Strings(r.order)
	return r, nil
}
