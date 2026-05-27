package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ── Domain types ──────────────────────────────────────────────────────────────

type Canvas struct {
	ID        uuid.UUID `json:"id"`
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	Mode      string    `json:"mode"`
	MapID     *string   `json:"mapId,omitempty"`
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Pin struct {
	ID        uuid.UUID `json:"id"`
	Kind      string    `json:"kind"` // always "pin"
	PinType   string    `json:"pinType"`
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Label     *string   `json:"label,omitempty"`
	Body      *string   `json:"body,omitempty"`
	Color     *string   `json:"color,omitempty"`
	CreatedBy string    `json:"createdBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Event struct {
	ID        uuid.UUID  `json:"id"`
	Kind      string     `json:"kind"` // always "event"
	Title     string     `json:"title"`
	Start     time.Time  `json:"start"`
	End       *time.Time `json:"end,omitempty"`
	PinID     *uuid.UUID `json:"pinId,omitempty"`
	CreatedBy string     `json:"createdBy"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

type Note struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "note"
	Body       string     `json:"body"`
	ImageRefs  []string   `json:"imageRefs"`
	ParentID   *uuid.UUID `json:"parentId,omitempty"`
	ParentKind *string    `json:"parentKind,omitempty"`
	CreatedBy  string     `json:"createdBy"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

type PendingEdit struct {
	ID          uuid.UUID `json:"id"`
	EntityID    uuid.UUID `json:"entityId"`
	Instruction string    `json:"instruction"`
	CreatedAt   time.Time `json:"createdAt"`
}

// CanvasState is the full snapshot sent to clients.
type CanvasState struct {
	Version int                    `json:"version"`
	Mode    string                 `json:"mode"`
	Pins    map[string]*Pin        `json:"pins"`
	Events  map[string]*Event      `json:"events"`
	Notes   map[string]*Note       `json:"notes"`
}

// ── Patch types (partial updates from JSON body) ──────────────────────────────

type PinPatch struct {
	PinType *string  `json:"pinType"`
	Lat     *float64 `json:"lat"`
	Lng     *float64 `json:"lng"`
	Label   *string  `json:"label"`
	Body    *string  `json:"body"`
	Color   *string  `json:"color"`
}

type EventPatch struct {
	Title  *string    `json:"title"`
	Start  *time.Time `json:"start"`
	End    *time.Time `json:"end"`
	PinID  *uuid.UUID `json:"pinId"`
}

type NotePatch struct {
	Body       *string    `json:"body"`
	ImageRefs  []string   `json:"imageRefs"`
	ParentID   *uuid.UUID `json:"parentId"`
	ParentKind *string    `json:"parentKind"`
}

// ── Store interface ───────────────────────────────────────────────────────────

type Store interface {
	// Canvas
	CreateCanvas(ctx context.Context, name string) (*Canvas, error)
	GetCanvasByCode(ctx context.Context, code string) (*Canvas, error)
	GetCanvasByID(ctx context.Context, id uuid.UUID) (*Canvas, error)
	GetCanvasState(ctx context.Context, canvasID uuid.UUID) (*Canvas, *CanvasState, []*PendingEdit, error)
	SetMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error)
	SetMapID(ctx context.Context, canvasID uuid.UUID, mapID string) (int, error)
	ApplyTemplate(ctx context.Context, canvasID uuid.UUID, mode string, mapID *string) (int, error)
	LeaveWelcomeIfNeeded(ctx context.Context, canvasID uuid.UUID, fallbackMode string) error

	// Pins
	CreatePin(ctx context.Context, canvasID uuid.UUID, p *Pin) (int, error)
	UpdatePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch PinPatch) (int, error)
	DeletePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Events
	CreateEvent(ctx context.Context, canvasID uuid.UUID, e *Event) (int, error)
	UpdateEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch EventPatch) (int, error)
	DeleteEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Notes
	CreateNote(ctx context.Context, canvasID uuid.UUID, n *Note) (int, error)
	UpdateNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch NotePatch) (int, error)
	DeleteNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Pending edits
	CreatePendingEdit(ctx context.Context, canvasID uuid.UUID, entityID uuid.UUID, instruction string) (*PendingEdit, error)
	DeletePendingEdit(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) error
	ListPendingEdits(ctx context.Context, canvasID uuid.UUID) ([]*PendingEdit, error)

	Close()
}
