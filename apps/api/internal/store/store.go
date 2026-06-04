package store

import (
	"context"
	"encoding/json"
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
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "event"
	Title      string      `json:"title"`
	Start      time.Time   `json:"start"`
	End        *time.Time  `json:"end,omitempty"`
	Timezone   *string     `json:"timezone,omitempty"`
	PinIDs     []uuid.UUID `json:"pinIds,omitempty"`
	PinID      *uuid.UUID  `json:"pinId,omitempty"`
	FromPinID  *uuid.UUID  `json:"fromPinId,omitempty"`
	ToPinID    *uuid.UUID `json:"toPinId,omitempty"`
	TravelMode *string    `json:"travelMode,omitempty"`
	DayTag     *string    `json:"dayTag,omitempty"`
	CreatedBy  string     `json:"createdBy"`
	UpdatedAt  time.Time  `json:"updatedAt"`
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

type RoadmapItem struct {
	ID        uuid.UUID  `json:"id"`
	Kind      string     `json:"kind"` // always "roadmap"
	ParentID  *uuid.UUID `json:"parentId,omitempty"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Status    string     `json:"status"`
	// Stage is a free-text phase label ("Now"/"Next"/"Later", "v1"/"v2", …)
	// used to group top-level goals into bands. Empty/absent = unstaged.
	Stage     string     `json:"stage,omitempty"`
	SortOrder int        `json:"sortOrder"`
	CreatedBy string     `json:"createdBy"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

type SheetColumn struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"` // "text" | "number" | "date" | "checkbox"
	SortOrder int    `json:"sortOrder"`
}

type Sheet struct {
	ID        uuid.UUID     `json:"id"`
	Kind      string        `json:"kind"` // always "sheet"
	Name      string        `json:"name"`
	Columns   []SheetColumn `json:"columns"`
	SortOrder int           `json:"sortOrder"`
	CreatedBy string        `json:"createdBy"`
	UpdatedAt time.Time     `json:"updatedAt"`
}

type SheetRow struct {
	ID        uuid.UUID              `json:"id"`
	Kind      string                 `json:"kind"` // always "sheetRow"
	SheetID   uuid.UUID              `json:"sheetId"`
	Data      map[string]any         `json:"data"` // keyed by SheetColumn.id; values: string|number|bool|null
	SortOrder int                    `json:"sortOrder"`
	CreatedBy string                 `json:"createdBy"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

type Chart struct {
	ID        uuid.UUID `json:"id"`
	Kind      string    `json:"kind"` // always "chart"
	Name      string    `json:"name"`
	SheetID   uuid.UUID `json:"sheetId"`
	ChartType string    `json:"chartType"` // "bar" | "line" | "area" | "pie"
	XColumn   string    `json:"xColumn"`   // SheetColumn.id
	YColumns  []string  `json:"yColumns"`  // SheetColumn.ids
	SortOrder int       `json:"sortOrder"`
	CreatedBy string    `json:"createdBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Action is the v1 execution primitive: the unit two agents coordinate on and
// a human approves before anything moves. Payload shape depends on Type; for
// "navigate" it is { goalLabel?, goal?{lat,lng}, waypoints?[{lat,lng}] }.
// Stored raw (json.RawMessage) so the canvas stays agnostic to payload shape.
type Action struct {
	ID           uuid.UUID       `json:"id"`
	Kind         string          `json:"kind"` // always "action"
	Type         string          `json:"type"`
	State        string          `json:"state"`
	Payload      json.RawMessage `json:"payload"`
	ProposedBy   string          `json:"proposedBy"`
	ApprovedBy   *string         `json:"approvedBy,omitempty"`
	Result       *string         `json:"result,omitempty"`
	Error        *string         `json:"error,omitempty"`
	LinkedPinIDs []uuid.UUID     `json:"linkedPinIds"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

// Agent is minimal identity so the canvas knows who is writing (provenance) and
// can show who is connected. Exactly one planner + one executor in v1.
type Agent struct {
	ID         uuid.UUID `json:"id"`
	Kind       string    `json:"kind"` // always "agent"
	Name       string    `json:"name"`
	Role       string    `json:"role"`
	Model      *string   `json:"model,omitempty"`
	Status     string    `json:"status"`
	LastSeenAt time.Time `json:"lastSeen"`
}

type User struct {
	ID          uuid.UUID `json:"id"`
	GoogleSub   string    `json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarUrl"`
	CreatedAt   time.Time `json:"createdAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

type PendingEdit struct {
	ID          uuid.UUID `json:"id"`
	EntityID    uuid.UUID `json:"entityId"`
	Instruction string    `json:"instruction"`
	CreatedAt   time.Time `json:"createdAt"`
}

// CanvasState is the full snapshot sent to clients.
type CanvasState struct {
	Version       int                          `json:"version"`
	Mode          string                       `json:"mode"`
	Pins          map[string]*Pin              `json:"pins"`
	Events        map[string]*Event            `json:"events"`
	Notes         map[string]*Note             `json:"notes"`
	RoadmapItems  map[string]*RoadmapItem      `json:"roadmapItems"`
	Sheets        map[string]*Sheet            `json:"sheets"`
	SheetRows     map[string]*SheetRow         `json:"sheetRows"`
	Charts        map[string]*Chart            `json:"charts"`
	Actions       map[string]*Action           `json:"actions"`
	Agents        map[string]*Agent            `json:"agents"`
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
	Title      *string      `json:"title"`
	Start      *time.Time   `json:"start"`
	End        *time.Time   `json:"end"`
	Timezone   *string      `json:"timezone"`
	PinIDs     *[]uuid.UUID `json:"pinIds"`
	PinID      *uuid.UUID   `json:"pinId"`
	FromPinID  *uuid.UUID   `json:"fromPinId"`
	ToPinID    *uuid.UUID `json:"toPinId"`
	TravelMode *string    `json:"travelMode"`
	DayTag     *string    `json:"dayTag"`
}

type NotePatch struct {
	Body       *string    `json:"body"`
	ImageRefs  []string   `json:"imageRefs"`
	ParentID   *uuid.UUID `json:"parentId"`
	ParentKind *string    `json:"parentKind"`
}

type RoadmapItemPatch struct {
	ParentID  *uuid.UUID `json:"parentId"`
	Title     *string    `json:"title"`
	Body      *string    `json:"body"`
	Status    *string    `json:"status"`
	// Stage: pass "" to clear (unstage), a label to set. nil = leave unchanged.
	Stage     *string    `json:"stage"`
	SortOrder *int       `json:"sortOrder"`
}

// RoadmapReorder is one entry in a bulk reorder. ParentID is always interpreted
// (nil means "set to NULL" / root-level), unlike RoadmapItemPatch where nil
// means "leave unchanged".
type RoadmapReorder struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parentId"`
	SortOrder int        `json:"sortOrder"`
}

type SheetPatch struct {
	Name      *string `json:"name"`
	SortOrder *int    `json:"sortOrder"`
}

type SheetColumnPatch struct {
	Name      *string `json:"name"`
	Type      *string `json:"type"`
	SortOrder *int    `json:"sortOrder"`
}

type SheetRowPatch struct {
	// Data is a partial merge into the existing row data (keys not present are
	// left untouched; explicit JSON null clears a field).
	Data      map[string]any `json:"data"`
	SortOrder *int           `json:"sortOrder"`
}

type SheetRowReorder struct {
	ID        uuid.UUID `json:"id"`
	SortOrder int       `json:"sortOrder"`
}

type ChartPatch struct {
	Name      *string    `json:"name"`
	SheetID   *uuid.UUID `json:"sheetId"`
	ChartType *string    `json:"chartType"`
	XColumn   *string    `json:"xColumn"`
	YColumns  *[]string  `json:"yColumns"`
	SortOrder *int       `json:"sortOrder"`
}

// ActionStatePatch carries a single state transition plus its outcome fields.
// State is required; Result/Error/ApprovedBy are set depending on the target
// (approve sets ApprovedBy; failed sets Error; done sets Result).
type ActionStatePatch struct {
	State      string  `json:"state"`
	Result     *string `json:"result"`
	Error      *string `json:"error"`
	ApprovedBy *string `json:"approvedBy"`
	// Payload, when non-nil, replaces the action payload — used by the executor
	// to write computed waypoints back before approval (safe: computing a path
	// does not move the robot).
	Payload json.RawMessage `json:"payload"`
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

	// Roadmap items
	CreateRoadmapItem(ctx context.Context, canvasID uuid.UUID, r *RoadmapItem) (int, error)
	UpdateRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch RoadmapItemPatch) (int, error)
	DeleteRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	ReorderRoadmapItems(ctx context.Context, canvasID uuid.UUID, updates []RoadmapReorder) (int, error)

	// Sheets + columns + rows
	CreateSheet(ctx context.Context, canvasID uuid.UUID, s *Sheet) (int, error)
	UpdateSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetPatch) (int, error)
	DeleteSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	AddSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, col SheetColumn) (int, error)
	UpdateSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string, patch SheetColumnPatch) (int, error)
	DeleteSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string) (int, error)
	CreateSheetRow(ctx context.Context, canvasID uuid.UUID, r *SheetRow) (int, error)
	UpdateSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetRowPatch) (int, error)
	DeleteSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	ReorderSheetRows(ctx context.Context, canvasID, sheetID uuid.UUID, updates []SheetRowReorder) (int, error)

	// Charts
	CreateChart(ctx context.Context, canvasID uuid.UUID, c *Chart) (int, error)
	UpdateChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch ChartPatch) (int, error)
	DeleteChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Agents (v1 identity / provenance)
	RegisterAgent(ctx context.Context, canvasID uuid.UUID, a *Agent) (int, error)

	// Actions (v1 execution primitive)
	CreateAction(ctx context.Context, canvasID uuid.UUID, a *Action) (int, error)
	GetAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, error)
	ListActions(ctx context.Context, canvasID uuid.UUID, stateFilter string) ([]*Action, error)
	UpdateActionState(ctx context.Context, canvasID, id uuid.UUID, patch ActionStatePatch) (int, error)

	// Users
	UpsertUserByGoogleSub(ctx context.Context, u *User) (*User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (*User, error)

	// Pending edits
	CreatePendingEdit(ctx context.Context, canvasID uuid.UUID, entityID uuid.UUID, instruction string) (*PendingEdit, error)
	DeletePendingEdit(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) error
	ListPendingEdits(ctx context.Context, canvasID uuid.UUID) ([]*PendingEdit, error)

	Close()
}
