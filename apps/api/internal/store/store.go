package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Claim outcomes. ClaimCanvas distinguishes these so the caller can return the
// right status (404 vs already-claimed vs bad token) and the web banner can offer
// "Copy instead" when a canvas is already owned.
var (
	ErrCanvasNotFound    = errors.New("canvas not found")
	ErrAlreadyClaimed    = errors.New("canvas already claimed")
	ErrInvalidClaimToken = errors.New("invalid claim token")
	ErrUserNotFound      = errors.New("user not found")
	// ErrInvalidToken is returned by UserIDByTokenHash when no live PAT matches.
	ErrInvalidToken = errors.New("invalid personal access token")
	// ErrInvalidGrant is returned by the OAuth code/refresh consumers when the
	// grant is missing, expired, revoked, or already used.
	ErrInvalidGrant = errors.New("invalid grant")
	// ErrActionNotFound is returned by ClaimAction/ReleaseAction when the id
	// doesn't resolve to an action in the canvas.
	ErrActionNotFound = errors.New("action not found")
	// ErrIllegalActionState wraps a ClaimAction/ReleaseAction that matched no
	// row because the action is in a state the transition doesn't apply to
	// (e.g. claiming a task still in 'proposed').
	ErrIllegalActionState = errors.New("illegal action state transition")
)

// AlreadyClaimedError is returned by ClaimAction when the conditional claim
// matched no row because another agent already holds it (state 'executing').
// Carries the current holder so the API can tell the loser who beat it.
type AlreadyClaimedError struct {
	ClaimedBy string
}

func (e *AlreadyClaimedError) Error() string {
	if e.ClaimedBy == "" {
		return "task already claimed"
	}
	return "task already claimed by " + e.ClaimedBy
}

// ── Domain types ──────────────────────────────────────────────────────────────

type Canvas struct {
	ID   uuid.UUID `json:"id"`
	Code string    `json:"code"`
	Name string    `json:"name"`
	// Mode is the ACTIVE mode — whichever view was last opened. It says nothing
	// about what the canvas contains; EnabledModes does. Anything describing a
	// canvas to a human (the dashboard cards, its filter) wants EnabledModes.
	Mode         string     `json:"mode"`
	EnabledModes []string   `json:"enabledModes"`
	MapID        *string    `json:"mapId,omitempty"`
	OwnerUserID  *uuid.UUID `json:"ownerUserId,omitempty"`
	// ClaimToken is the private "own this canvas" capability for an anonymous
	// canvas. It is deliberately surfaced ONLY on the create response (so the
	// creator can hand it to the intended human) and never on any read path —
	// toCanvas() leaves it empty, so GetCanvasByCode / state / list never leak it.
	// See migration 0020.
	ClaimToken string `json:"claimToken,omitempty"`
	// Visibility ('public'|'private') + PublicRole ('read'|'write') drive access
	// control (migration 0021). Safe to expose on read paths — they describe the
	// share posture, not a secret. YourRole is the requester's resolved role for
	// this canvas ('write'|'read'|'none'); it is NOT stored, so toCanvas leaves it
	// empty and handlers fill it per-request via ResolveCanvasRole.
	Visibility string    `json:"visibility,omitempty"`
	PublicRole string    `json:"publicRole,omitempty"`
	YourRole   string    `json:"yourRole,omitempty"`
	// ApprovalPolicy ('strict'|'epic'|'auto', migration 0033) sets how much human
	// gating agent-proposed tasks get. Empty (legacy row) is treated as 'epic',
	// the DB default. Enforced in the action create/approve handlers.
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
	Version    int       `json:"version"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// CanvasAccess is one account a canvas has been shared with (a canvas_access row
// joined to the user it points at). Returned by the owner-only member list.
type CanvasAccess struct {
	UserID      uuid.UUID `json:"userId"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarUrl"`
	Role        string    `json:"role"`
}

// Notification is one entry in an account's inbox (migration 0022). Today the
// only kind is 'canvas_shared' — emitted when an owner shares a canvas with this
// user. CanvasCode/CanvasName/ActorName are joined in for display so the client
// needs no follow-up lookups.
type Notification struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"`
	CanvasID   *uuid.UUID `json:"canvasId,omitempty"`
	CanvasCode string     `json:"canvasCode,omitempty"`
	CanvasName string     `json:"canvasName,omitempty"`
	ActorName  string     `json:"actorName,omitempty"`
	Role       string     `json:"role,omitempty"`
	Read       bool       `json:"read"`
	CreatedAt  time.Time  `json:"createdAt"`

	// Write-only routing fields, set by the caller when creating a notification.
	// Unexported so they never serialize onto the read/response path.
	recipientID uuid.UUID  // whose inbox (notifications.user_id)
	actorID     *uuid.UUID // who caused it (notifications.actor_user_id)
}

// NewNotification builds a notification ready for CreateNotification, carrying
// the recipient + actor in the unexported routing fields.
func NewNotification(recipientID uuid.UUID, kind string, canvasID *uuid.UUID, actorID *uuid.UUID, role string) *Notification {
	return &Notification{
		Kind:        kind,
		CanvasID:    canvasID,
		Role:        role,
		recipientID: recipientID,
		actorID:     actorID,
	}
}

type Pin struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "pin"
	DocumentID *uuid.UUID `json:"documentId,omitempty"`
	PinType    string     `json:"pinType"`
	Lat        float64    `json:"lat"`
	Lng        float64    `json:"lng"`
	Label      *string    `json:"label,omitempty"`
	Body       *string    `json:"body,omitempty"`
	Color      *string    `json:"color,omitempty"`
	CreatedBy  string     `json:"createdBy"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

type Event struct {
	ID         uuid.UUID   `json:"id"`
	Kind       string      `json:"kind"` // always "event"
	DocumentID *uuid.UUID  `json:"documentId,omitempty"`
	Title      string      `json:"title"`
	Start      time.Time   `json:"start"`
	End        *time.Time  `json:"end,omitempty"`
	Timezone   *string     `json:"timezone,omitempty"`
	PinIDs     []uuid.UUID `json:"pinIds,omitempty"`
	PinID      *uuid.UUID  `json:"pinId,omitempty"`
	FromPinID  *uuid.UUID  `json:"fromPinId,omitempty"`
	ToPinID    *uuid.UUID  `json:"toPinId,omitempty"`
	TravelMode *string     `json:"travelMode,omitempty"`
	DayTag     *string     `json:"dayTag,omitempty"`
	Cost       *float64    `json:"cost,omitempty"`
	CreatedBy  string      `json:"createdBy"`
	UpdatedAt  time.Time   `json:"updatedAt"`
}

type Note struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "note"
	DocumentID *uuid.UUID `json:"documentId,omitempty"`
	Body       string     `json:"body"`
	ImageRefs  []string   `json:"imageRefs"`
	ParentID   *uuid.UUID `json:"parentId,omitempty"`
	ParentKind *string    `json:"parentKind,omitempty"`
	SortOrder  int        `json:"sortOrder"`
	CreatedBy  string     `json:"createdBy"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

type RoadmapItem struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "roadmap"
	DocumentID *uuid.UUID `json:"documentId,omitempty"`
	ParentID   *uuid.UUID `json:"parentId,omitempty"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	Status     string     `json:"status"`
	// Stage is a free-text phase label ("Now"/"Next"/"Later", "v1"/"v2", …)
	// used to group top-level goals into bands. Empty/absent = unstaged.
	Stage string `json:"stage,omitempty"`
	// Assignee marks who the item is FOR: "agent" = an agent task a session
	// pulls and executes; empty/absent = a human goal (the default).
	Assignee  string    `json:"assignee,omitempty"`
	SortOrder int       `json:"sortOrder"`
	CreatedBy string    `json:"createdBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type SheetColumn struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"` // "text" | "number" | "date" | "checkbox"
	SortOrder int    `json:"sortOrder"`
}

type Sheet struct {
	ID         uuid.UUID     `json:"id"`
	Kind       string        `json:"kind"` // always "sheet"
	DocumentID *uuid.UUID    `json:"documentId,omitempty"`
	Name       string        `json:"name"`
	Columns    []SheetColumn `json:"columns"`
	SortOrder  int           `json:"sortOrder"`
	CreatedBy  string        `json:"createdBy"`
	UpdatedAt  time.Time     `json:"updatedAt"`
}

type SheetRow struct {
	ID        uuid.UUID      `json:"id"`
	Kind      string         `json:"kind"` // always "sheetRow"
	SheetID   uuid.UUID      `json:"sheetId"`
	Data      map[string]any `json:"data"` // keyed by SheetColumn.id; values: string|number|bool|null
	SortOrder int            `json:"sortOrder"`
	CreatedBy string         `json:"createdBy"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

type Chart struct {
	ID         uuid.UUID  `json:"id"`
	Kind       string     `json:"kind"` // always "chart"
	DocumentID *uuid.UUID `json:"documentId,omitempty"`
	Name       string     `json:"name"`
	SheetID    uuid.UUID  `json:"sheetId"`
	ChartType  string     `json:"chartType"` // "bar" | "line" | "area" | "pie"
	XColumn    string     `json:"xColumn"`   // SheetColumn.id
	YColumns   []string   `json:"yColumns"`  // SheetColumn.ids
	SortOrder  int        `json:"sortOrder"`
	CreatedBy  string     `json:"createdBy"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// ── Forms (direct-input layer) ────────────────────────────────────────────────
// A Form is an agent-defined recipe a human fills from a lightweight surface to
// mutate the canvas directly (no agent in the submit loop). Fields is the input
// schema; Actions is the compiled, canonical DSL the resolver runs at submit.
// See docs/DESIGN_DIRECT_INPUT.md.

type Form struct {
	ID          uuid.UUID    `json:"id"`
	Kind        string       `json:"kind"` // always "form"
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Fields      []FormField  `json:"fields"`
	Actions     []FormAction `json:"actions"`
	SortOrder   int          `json:"sortOrder"`
	CreatedBy   string       `json:"createdBy"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

// FormField is one input the human fills. Type ∈ text|number|date|select|checkbox.
type FormField struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type"`
	Required    bool     `json:"required,omitempty"`
	Options     []string `json:"options,omitempty"`     // required iff select
	Default     any      `json:"default,omitempty"`     // type-compatible default
	Placeholder string   `json:"placeholder,omitempty"` // text/number only
}

// FormAction is one entry of the canonical DSL (forms.actions). The agent never
// writes this directly — compile() expands the authoring Intent into it.
// Op ∈ sheet.row.append | sheet.row.upsert | pin.patch. Columns are referenced
// by NAME and resolved name→id at submit (so they survive column recreation).
type FormAction struct {
	Op     string     `json:"op"`
	Target FormTarget `json:"target"`
	Set    []Binding  `json:"set"`
	Match  []Binding  `json:"match,omitempty"` // upsert only
	Inc    []string   `json:"inc,omitempty"`   // upsert only: column names to increment
}

// FormTarget is a discriminated target: exactly one of Sheet (by name) or Pin (by id).
type FormTarget struct {
	Sheet string `json:"sheet,omitempty"`
	Pin   string `json:"pin,omitempty"`
}

// Binding maps a target column (by name) to a value expression.
type Binding struct {
	Column string    `json:"column"`
	Value  ValueExpr `json:"value"`
}

// ValueExpr is exactly one of: From (a submitted field key), Computed
// ("today"|"now"), or Literal (a raw scalar). Presence is detected by which is
// non-empty; the exactly-one-key invariant is enforced by compile().
type ValueExpr struct {
	From     string          `json:"from,omitempty"`
	Computed string          `json:"computed,omitempty"`
	Literal  json.RawMessage `json:"literal,omitempty"`
}

// Batch is the concrete, scope-checked result of resolving a form submission —
// the input to the submit_canvas_form RPC. Every name is already a uuid and
// every value concrete by the time a Batch exists.
type Batch struct {
	Inserts []RowInsert `json:"inserts"`
	Patches []Patch     `json:"patches"`
}

// RowInsert appends a new sheet row. Data is keyed by SheetColumn.id.
type RowInsert struct {
	SheetID string         `json:"sheet_id"`
	Data    map[string]any `json:"data"`
}

// Patch is either a sheet-row patch (RowID + Set/Inc, keyed by column id) or a
// pin patch (PinID + Set, keyed by whitelisted column). Exactly one id is set.
type Patch struct {
	RowID *string            `json:"row_id,omitempty"`
	PinID *string            `json:"pin_id,omitempty"`
	Set   map[string]any     `json:"set,omitempty"`
	Inc   map[string]float64 `json:"inc,omitempty"`
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
	// ClaimedBy/ClaimedAt record which agent holds the executing claim (set by
	// ClaimAction, cleared by ReleaseAction). Migration 0032.
	ClaimedBy    *string         `json:"claimedBy,omitempty"`
	ClaimedAt    *time.Time      `json:"claimedAt,omitempty"`
	Result       *string         `json:"result,omitempty"`
	Error        *string         `json:"error,omitempty"`
	LinkedPinIDs []uuid.UUID     `json:"linkedPinIds"`
	// Ticket is the per-canvas sequential task number (type "task" only; nil
	// for other action types). Only the integer is stored — the "TDM-<n>"
	// display form is added at serialization time (see MarshalJSON).
	Ticket    *int      `json:"ticket,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// MarshalJSON adds the ticket's display form ("TDM-<n>", as ticketId) to every
// serialization of an Action — REST responses and WS state broadcasts alike —
// while the DB stores only the integer.
func (a *Action) MarshalJSON() ([]byte, error) {
	type actionAlias Action // alias sheds the method, avoiding recursion
	out := struct {
		*actionAlias
		TicketID string `json:"ticketId,omitempty"`
	}{actionAlias: (*actionAlias)(a)}
	if a.Ticket != nil {
		out.TicketID = fmt.Sprintf("TDM-%d", *a.Ticket)
	}
	return json.Marshal(out)
}

// TaskLink is a linked entity resolved from a task action's payload.linkedIds —
// the context a session needs to start work without pulling full canvas state.
// Kind is "roadmap" or "note"; Title/Status are empty for notes.
type TaskLink struct {
	ID     uuid.UUID `json:"id"`
	Kind   string    `json:"kind"`
	Title  string    `json:"title,omitempty"`
	Body   string    `json:"body"`
	Status string    `json:"status,omitempty"`
}

// Agent is minimal identity so the canvas knows who is writing (provenance) and
// can show who is connected. ParentAgentID links an executor subagent to the
// orchestrator (planner) that spawned it — the structural signal the swarm view
// groups on. Nil = unparented (renders flat).
type Agent struct {
	ID            uuid.UUID  `json:"id"`
	Kind          string     `json:"kind"` // always "agent"
	Name          string     `json:"name"`
	Role          string     `json:"role"`
	Model         *string    `json:"model,omitempty"`
	ParentAgentID *uuid.UUID `json:"parentAgentId,omitempty"`
	Status        string     `json:"status"`
	LastSeenAt    time.Time  `json:"lastSeen"`
}

type User struct {
	ID          uuid.UUID `json:"id"`
	GoogleSub   string    `json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	AvatarURL   string    `json:"avatarUrl"`
	// DefaultCanvasVisibility is the user's preference ('public'|'private') for
	// how canvases they create start out — applied in CreateCanvas.
	DefaultCanvasVisibility string `json:"defaultCanvasVisibility"`
	// DefaultPublicRole is the user's preference ('read'|'write') for what a bare
	// code-holder gets on a PUBLIC canvas they create — applied in CreateCanvas.
	// Does not affect owner/shared-member access (see ResolveCanvasRole).
	DefaultPublicRole string `json:"defaultPublicRole"`
	// AgentFollowStyle is the user's preference ('cinematic'|'minimal') for how
	// the agent-activity showcase auto-scrolls a batch change into view. Purely a
	// client-side display preference; the server just stores and echoes it.
	AgentFollowStyle string    `json:"agentFollowStyle"`
	CreatedAt         time.Time `json:"createdAt"`
	LastSeenAt        time.Time `json:"lastSeenAt"`
}

// PersonalAccessToken is one user-scoped MCP credential (migration 0027). The
// secret itself is never held here — only its metadata. The plaintext is
// returned exactly once, at mint time, via CreatePersonalAccessToken's separate
// return value.
type PersonalAccessToken struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	LastFour   string     `json:"lastFour"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

// ── OAuth 2.1 authorization server (migration 0029) ─────────────────────────────

// OAuthClient is a dynamically-registered MCP client (claude.ai self-registers).
// Public client: PKCE, no secret.
type OAuthClient struct {
	ID                      string    `json:"id"`
	ClientName              string    `json:"clientName"`
	RedirectURIs            []string  `json:"redirectUris"`
	GrantTypes              []string  `json:"grantTypes"`
	TokenEndpointAuthMethod string    `json:"tokenEndpointAuthMethod"`
	CreatedAt               time.Time `json:"createdAt"`
}

// AllowsRedirect reports whether uri exactly matches one of the client's
// registered redirect URIs — the anti-open-redirect check in the authorize flow.
func (c *OAuthClient) AllowsRedirect(uri string) bool {
	for _, u := range c.RedirectURIs {
		if u == uri {
			return true
		}
	}
	return false
}

// OAuthCode is the pending authorization-code grant bridging /authorize and
// /token. Stored hashed and single-use; never returned to a client verbatim.
type OAuthCode struct {
	ClientID            string
	UserID              uuid.UUID
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Scope               string
	Resource            string
	ExpiresAt           time.Time
}

// OAuthGrant is the persisted state behind an issued token pair (access +
// refresh). The secrets live only as hashes; this carries the metadata the token
// endpoint and resolver need.
type OAuthGrant struct {
	ID               uuid.UUID
	ClientID         string
	UserID           uuid.UUID
	Scope            string
	Resource         string
	AccessExpiresAt  time.Time
	RefreshExpiresAt *time.Time
}

// OAuthConnection is a user-facing "connected app" — one client the user has an
// active authorization with, shown on /me so they can revoke it.
type OAuthConnection struct {
	ClientID   string     `json:"clientId"`
	ClientName string     `json:"clientName"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

type PendingEdit struct {
	ID          uuid.UUID `json:"id"`
	EntityID    uuid.UUID `json:"entityId"`
	Instruction string    `json:"instruction"`
	CreatedAt   time.Time `json:"createdAt"`
}

// Document is a named, multi-instance tab on a canvas (migration 0024). It
// generalizes what sheets already do to every view type: a canvas is a bag of
// documents, each with a Type (map/notes/itinerary/roadmap/sheet/chart), a Name,
// and a SortOrder. Child rows (pins/events/notes/roadmap items/sheets/charts)
// point back at their document via DocumentID. Config carries type-specific
// settings — e.g. {"mapId":"tokyo"} for a map document.
//
// ParentID is reserved for a future folder tree (the document explorer sidebar,
// roadmap item 9) — it is always null today, so the model is flat now but a tree
// can be layered on with no schema rework.
type Document struct {
	ID        uuid.UUID      `json:"id"`
	Kind      string         `json:"kind"` // always "document"
	Type      string         `json:"type"`
	Name      string         `json:"name"`
	ParentID  *uuid.UUID     `json:"parentId,omitempty"`
	SortOrder int            `json:"sortOrder"`
	Config    map[string]any `json:"config"`
	CreatedBy string         `json:"createdBy"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// CanvasState is the full snapshot sent to clients.
type CanvasState struct {
	Version      int                     `json:"version"`
	Mode         string                  `json:"mode"`
	EnabledModes []string                `json:"enabledModes"`
	Documents    map[string]*Document    `json:"documents"`
	Pins         map[string]*Pin         `json:"pins"`
	Events       map[string]*Event       `json:"events"`
	Notes        map[string]*Note        `json:"notes"`
	RoadmapItems map[string]*RoadmapItem `json:"roadmapItems"`
	Sheets       map[string]*Sheet       `json:"sheets"`
	SheetRows    map[string]*SheetRow    `json:"sheetRows"`
	Charts       map[string]*Chart       `json:"charts"`
	Forms        map[string]*Form        `json:"forms"`
	Actions      map[string]*Action      `json:"actions"`
	Agents       map[string]*Agent       `json:"agents"`
}

// CanvasSummary is the cheap, navigational shape behind canvas_state_read's
// default read. Instead of loading the whole canvas and counting/clipping it in
// Go, the store fills this with EXACT per-kind counts (count=exact HEAD/range
// queries — no rows transferred) plus a capped Sample of each kind carrying just
// enough columns to render a name. So a summary read on a 100k-item board stays
// cheap end-to-end, not just on the wire.
//
// Sample reuses CanvasState so the API layer's name-formatting (clip, "(type)",
// first-line, sort, "+N more") stays in one place; only the requested name
// columns are populated, the rest are zero. Counts are authoritative — Sample is
// capped, so never derive a count from len(Sample.X).
type CanvasSummary struct {
	Version      int
	Mode         string
	EnabledModes []string
	Counts       map[string]int
	Sample       *CanvasState
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
	ToPinID    *uuid.UUID   `json:"toPinId"`
	TravelMode *string      `json:"travelMode"`
	DayTag     *string      `json:"dayTag"`
	Cost       *float64     `json:"cost"`
	// Explicit clears — a nil pointer can't be distinguished from JSON null, so
	// removing an optional field (rather than setting it) rides its own flag.
	ClearEnd  bool `json:"clearEnd"`
	ClearCost bool `json:"clearCost"`
}

type NotePatch struct {
	Body       *string    `json:"body"`
	ImageRefs  []string   `json:"imageRefs"`
	ParentID   *uuid.UUID `json:"parentId"`
	ParentKind *string    `json:"parentKind"`
	SortOrder  *int       `json:"sortOrder"`
}

type RoadmapItemPatch struct {
	ParentID *uuid.UUID `json:"parentId"`
	Title    *string    `json:"title"`
	Body     *string    `json:"body"`
	Status   *string    `json:"status"`
	// Stage: pass "" to clear (unstage), a label to set. nil = leave unchanged.
	Stage *string `json:"stage"`
	// Assignee: "agent" marks it as an agent task, "" (or "human") clears the
	// mark back to a human goal. nil = leave unchanged.
	Assignee  *string `json:"assignee"`
	SortOrder *int    `json:"sortOrder"`
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

type DocumentPatch struct {
	Name      *string        `json:"name"`
	SortOrder *int           `json:"sortOrder"`
	Config    map[string]any `json:"config"`
	// Folder membership (item 8.5). SetParent gates whether parent_id is touched
	// at all — when true, ParentID nil clears it (moves the document to the root),
	// non-nil moves it into that folder. nil ParentID with SetParent=false leaves
	// it unchanged. (The REST handler resolves a folder ref into ParentID.)
	ParentID  *uuid.UUID
	SetParent bool
}

// DocumentReorder is one entry in a bulk tab reorder (drag-and-drop). ParentID is
// always interpreted (nil = root / clear), like RoadmapReorder — so a single
// reorder both moves a document between folders and positions it among siblings.
type DocumentReorder struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parentId"`
	SortOrder int        `json:"sortOrder"`
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

// FormPatch replaces a form's authoring surface wholesale (the compiler always
// re-expands the full intent). nil fields are left unchanged.
type FormPatch struct {
	Name        *string       `json:"name"`
	Description *string       `json:"description"`
	Fields      *[]FormField  `json:"fields"`
	Actions     *[]FormAction `json:"actions"`
	SortOrder   *int          `json:"sortOrder"`
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
	// visibility ('public'|'private', or "" to accept the DB default of public)
	// and publicRole ('read'|'write', or "" for the DB default) are the owner's
	// chosen starting posture for the new canvas.
	CreateCanvas(ctx context.Context, name string, ownerUserID *uuid.UUID, visibility, publicRole string) (*Canvas, error)
	ListCanvasesByOwner(ctx context.Context, ownerUserID uuid.UUID) ([]*Canvas, error)
	CopyCanvas(ctx context.Context, srcID, ownerUserID uuid.UUID, name string) (*Canvas, error)
	// ClaimCanvas atomically transfers an unowned canvas to ownerUserID iff the
	// claimToken matches and the canvas is still unowned, voiding the token on
	// success. Returns ErrCanvasNotFound / ErrAlreadyClaimed / ErrInvalidClaimToken.
	ClaimCanvas(ctx context.Context, code, claimToken string, ownerUserID uuid.UUID) (*Canvas, error)
	// DeleteCanvas permanently removes a canvas by id. All content, access rows,
	// and notifications FK canvases with ON DELETE CASCADE, so they go with it.
	// Ownership is enforced by the caller (owner-only).
	DeleteCanvas(ctx context.Context, canvasID uuid.UUID) error
	CanvasCount(ctx context.Context) (int, error)
	UserCount(ctx context.Context) (int, error)
	CanvasRecurrence(ctx context.Context) (revisited int, total int, err error)
	GetCanvasByCode(ctx context.Context, code string) (*Canvas, error)
	GetCanvasByID(ctx context.Context, id uuid.UUID) (*Canvas, error)

	// Access control (migration 0021). ResolveCanvasRole is the single source of
	// truth used by the WS upgrade + /api/mcp/auth: given an already-loaded canvas
	// and an optional logged-in user, returns "write" | "read" | "none". The
	// remaining methods back the owner-only sharing UI.
	ResolveCanvasRole(ctx context.Context, canvas *Canvas, userID *uuid.UUID) (string, error)
	SetCanvasVisibility(ctx context.Context, canvasID uuid.UUID, visibility, publicRole string) (int, error)
	SetCanvasName(ctx context.Context, canvasID uuid.UUID, name string) (int, error)
	// SetCanvasApprovalPolicy sets the canvas approval policy
	// ('strict'|'epic'|'auto', migration 0033). Validation is the caller's job.
	SetCanvasApprovalPolicy(ctx context.Context, canvasID uuid.UUID, policy string) (int, error)
	ListCanvasAccess(ctx context.Context, canvasID uuid.UUID) ([]*CanvasAccess, error)
	UpsertCanvasAccess(ctx context.Context, canvasID, userID uuid.UUID, role string) error
	DeleteCanvasAccess(ctx context.Context, canvasID, userID uuid.UUID) error
	// ListCanvasesSharedWithUser returns canvases another owner has shared with
	// this user (canvas_access rows where user_id = userID), each Canvas carrying
	// the granted role in YourRole. Powers the "shared with you" list — the
	// recipient-side mirror of the owner-only ListCanvasAccess.
	ListCanvasesSharedWithUser(ctx context.Context, userID uuid.UUID) ([]*Canvas, error)

	// Notifications (migration 0022) — the account-level inbox.
	CreateNotification(ctx context.Context, n *Notification) error
	ListNotifications(ctx context.Context, userID uuid.UUID, limit int) ([]*Notification, error)
	CountUnreadNotifications(ctx context.Context, userID uuid.UUID) (int, error)
	MarkNotificationsRead(ctx context.Context, userID uuid.UUID) error
	GetCanvasState(ctx context.Context, canvasID uuid.UUID) (*Canvas, *CanvasState, []*PendingEdit, error)
	// BumpCanvasVersion increments the canvas version once and returns the new
	// value. The per-item Update*/Delete* methods normally bump it themselves, but
	// the batch handlers suppress that (see WithoutVersionBump) and call this once
	// after all writes land — one bump per batch instead of N, and no lock
	// contention on the canvas row among the concurrent writers.
	BumpCanvasVersion(ctx context.Context, canvasID uuid.UUID) (int, error)
	// GetCanvasKinds is the lightweight sibling of GetCanvasState: it loads only
	// the requested kinds via per-table SELECTs (kinds not asked for stay nil, so
	// they serialize to null), plus the canvas row and pending edits. Backs the
	// fields-filtered canvas_state_read so a single-field read no longer triggers a
	// full-canvas DB load. Same return shape as GetCanvasState.
	GetCanvasKinds(ctx context.Context, canvasID uuid.UUID, kinds []string) (*Canvas, *CanvasState, []*PendingEdit, error)
	// GetCanvasSummary backs the default (summary) canvas_state_read: exact per-kind
	// counts plus a name-column-only Sample capped at sampleLimit rows per kind, so
	// the DB does the trimming instead of loading the whole canvas to count and clip.
	GetCanvasSummary(ctx context.Context, canvasID uuid.UUID, sampleLimit int) (*Canvas, *CanvasSummary, []*PendingEdit, error)
	SetMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error)
	EnableMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error)
	SetMapID(ctx context.Context, canvasID uuid.UUID, mapID string) (int, error)
	ApplyTemplate(ctx context.Context, canvasID uuid.UUID, mode string, mapID *string) (int, error)
	LeaveWelcomeIfNeeded(ctx context.Context, canvasID uuid.UUID, fallbackMode string) error

	// Documents (migration 0024) — named, multi-instance tabs. Child rows point
	// back via document_id; ListDocuments powers name/id targeting.
	CreateDocument(ctx context.Context, canvasID uuid.UUID, d *Document) (int, error)
	// CreateDocuments bulk-inserts many documents in one round trip (one INSERT,
	// one version bump) instead of N of each.
	CreateDocuments(ctx context.Context, canvasID uuid.UUID, docs []*Document) (int, error)
	UpdateDocument(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch DocumentPatch) (int, error)
	DeleteDocument(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	ReorderDocuments(ctx context.Context, canvasID uuid.UUID, updates []DocumentReorder) (int, error)
	ListDocuments(ctx context.Context, canvasID uuid.UUID) ([]*Document, error)
	GetDocument(ctx context.Context, canvasID, id uuid.UUID) (*Document, error)

	// Pins
	CreatePin(ctx context.Context, canvasID uuid.UUID, p *Pin) (int, error)
	CreatePins(ctx context.Context, canvasID uuid.UUID, pins []*Pin) (int, error)
	UpdatePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch PinPatch) (int, error)
	DeletePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Events
	CreateEvent(ctx context.Context, canvasID uuid.UUID, e *Event) (int, error)
	CreateEvents(ctx context.Context, canvasID uuid.UUID, events []*Event) (int, error)
	UpdateEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch EventPatch) (int, error)
	DeleteEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Notes
	CreateNote(ctx context.Context, canvasID uuid.UUID, n *Note) (int, error)
	CreateNotes(ctx context.Context, canvasID uuid.UUID, notes []*Note) (int, error)
	UpdateNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch NotePatch) (int, error)
	DeleteNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Roadmap items
	CreateRoadmapItem(ctx context.Context, canvasID uuid.UUID, r *RoadmapItem) (int, error)
	CreateRoadmapItems(ctx context.Context, canvasID uuid.UUID, items []*RoadmapItem) (int, error)
	UpdateRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch RoadmapItemPatch) (int, error)
	DeleteRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	ReorderRoadmapItems(ctx context.Context, canvasID uuid.UUID, updates []RoadmapReorder) (int, error)
	// ListRoadmapItems returns a canvas's roadmap items, optionally filtered by
	// assignee ("agent" = the agent-task queue; "" = all).
	ListRoadmapItems(ctx context.Context, canvasID uuid.UUID, assignee string) ([]*RoadmapItem, error)

	// Sheets + columns + rows
	CreateSheet(ctx context.Context, canvasID uuid.UUID, s *Sheet) (int, error)
	UpdateSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetPatch) (int, error)
	DeleteSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	AddSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, col SheetColumn) (int, error)
	CreateSheetColumns(ctx context.Context, canvasID, sheetID uuid.UUID, cols []SheetColumn) (int, error)
	UpdateSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string, patch SheetColumnPatch) (int, error)
	DeleteSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string) (int, error)
	CreateSheetRow(ctx context.Context, canvasID uuid.UUID, r *SheetRow) (int, error)
	CreateSheetRows(ctx context.Context, canvasID uuid.UUID, rows []*SheetRow) (int, error)
	UpdateSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetRowPatch) (int, error)
	DeleteSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	ReorderSheetRows(ctx context.Context, canvasID, sheetID uuid.UUID, updates []SheetRowReorder) (int, error)

	// Charts
	CreateChart(ctx context.Context, canvasID uuid.UUID, c *Chart) (int, error)
	// CreateCharts bulk-inserts many charts in one round trip (one INSERT, one
	// version bump), minting any needed backing 'chart' documents in a single
	// bulk documents INSERT rather than N individual CreateDocument calls.
	CreateCharts(ctx context.Context, canvasID uuid.UUID, charts []*Chart) (int, error)
	UpdateChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch ChartPatch) (int, error)
	DeleteChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)

	// Forms (direct-input layer)
	CreateForm(ctx context.Context, canvasID uuid.UUID, f *Form) (int, error)
	GetForm(ctx context.Context, canvasID, id uuid.UUID) (*Form, error)
	UpdateForm(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch FormPatch) (int, error)
	DeleteForm(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error)
	// SubmitForm applies a resolved batch atomically (submit_canvas_form RPC),
	// deduping by submissionID when non-empty, and returns the new version.
	SubmitForm(ctx context.Context, canvasID uuid.UUID, batch Batch, submissionID string) (int, error)

	// Agents (v1 identity / provenance)
	// RegisterAgent UPSERTs on the (canvas_id, name) identity (unique since
	// migration 0036): first registration inserts; re-registering the same name
	// refreshes role/model/parent_agent_id/status/last_seen_at on the existing
	// row and KEEPS its id. On return a.ID is the surviving row's real id.
	RegisterAgent(ctx context.Context, canvasID uuid.UUID, a *Agent) (int, error)
	// GetAgent fetches one agent scoped to a canvas (parentAgentId validation).
	GetAgent(ctx context.Context, canvasID, id uuid.UUID) (*Agent, error)
	// TouchAgentLastSeen bumps last_seen_at (and re-marks online) for the agent a
	// claimant identity resolves to — the liveness heartbeat behind the swarm
	// view. Claimant is the task_start/complete identity: the registered agent
	// NAME (preferred) or agent id; since 0036 a name matches at most one row.
	// Best-effort; no version bump (presence-only — the fresh timestamp rides
	// the caller's own state broadcast).
	TouchAgentLastSeen(ctx context.Context, canvasID uuid.UUID, claimant string) error
	// TouchOrCreateAgent is the claim-path heartbeat: touch the claimant's row,
	// and when a NAME claimant has none, create a minimal executor registration
	// via the same (canvas_id, name) upsert as RegisterAgent — a session that
	// claims a task without ever calling agent_register still appears in
	// presence/swarm views. Skips ""/"agent"; id claimants are touched only.
	// Best-effort, called detached — never on the claim's critical path.
	TouchOrCreateAgent(ctx context.Context, canvasID uuid.UUID, claimant string) error

	// Actions (v1 execution primitive)
	CreateAction(ctx context.Context, canvasID uuid.UUID, a *Action) (int, error)
	CreateActions(ctx context.Context, canvasID uuid.UUID, actions []*Action) (int, error)
	GetAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, error)
	ListActions(ctx context.Context, canvasID uuid.UUID, stateFilter, typeFilter, assigneeFilter string) ([]*Action, error)
	UpdateActionState(ctx context.Context, canvasID, id uuid.UUID, patch ActionStatePatch) (int, error)
	// ClaimAction atomically claims an approved action for claimedBy — a single
	// conditional UPDATE (… WHERE state='approved') decides the winner in the DB,
	// so two concurrent task_starts can't both win. An 'executing' claim older
	// than the claim TTL (lazy expiry, no sweeper; see store.DefaultClaimTTL /
	// WithClaimTTL, 0 disables) is atomically taken over by a second conditional
	// UPDATE (… WHERE state='executing' AND claimed_at < cutoff), restamping
	// claimed_by/claimed_at. Returns the claimed action + new canvas version,
	// ErrActionNotFound, *AlreadyClaimedError (with the current holder — the
	// NEW one if a takeover race was lost), or an ErrIllegalActionState-wrapped
	// error for other states.
	ClaimAction(ctx context.Context, canvasID, id uuid.UUID, claimedBy string) (*Action, int, error)
	// ReleaseAction frees a stuck claim: executing → approved, clearing
	// claimed_by/claimed_at, via the same conditional-UPDATE pattern. Human-only —
	// the gate lives at the route surface (see api.ReleaseAction).
	ReleaseAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, int, error)
	// RequeueAction sends a FAILED task back to the queue: failed → approved,
	// clearing claimed_by/claimed_at and error, via the same conditional-UPDATE
	// pattern. Human-only — the gate lives at the route surface (see
	// api.RequeueAction); agents must not requeue their own failures.
	RequeueAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, int, error)
	UpdateActionPayload(ctx context.Context, canvasID, id uuid.UUID, payload json.RawMessage) (int, error)
	DeleteAction(ctx context.Context, canvasID, id uuid.UUID) (int, error)
	// ApproveEpicTasks batch-approves every currently-proposed task under an epic
	// (actions rows with type='task', state='proposed', payload epicId = epicID)
	// in ONE bulk UPDATE, stamping approved_by (the 'policy:epic' provenance).
	// Tasks self-flagged requiresApproval:true are skipped — they keep their
	// individual human gate. Returns the number of tasks approved; the canvas
	// version is bumped only when that count is non-zero.
	ApproveEpicTasks(ctx context.Context, canvasID, epicID uuid.UUID, approvedBy string) (int, error)
	// ApproveActionsBatch flips every listed action still in 'proposed' to
	// approved in ONE bulk conditional UPDATE (id IN ids AND canvas_id AND
	// state='proposed'), stamping approved_by. Ids that don't match (missing,
	// wrong canvas, or no longer proposed) are silently skipped — the caller
	// diffs the returned rows against its input to report them. The canvas
	// version is bumped once, only when at least one row changed.
	ApproveActionsBatch(ctx context.Context, canvasID uuid.UUID, ids []uuid.UUID, approvedBy string) ([]*Action, error)
	GetLinkedEntities(ctx context.Context, canvasID uuid.UUID, ids []uuid.UUID) ([]TaskLink, error)
	// ReserveTaskTickets atomically reserves n consecutive per-canvas ticket
	// numbers (reserve_task_tickets RPC, migration 0034) and returns the FIRST
	// of the range. Race-safe under concurrent task creation: the increment is
	// a single UPDATE on the canvas row.
	ReserveTaskTickets(ctx context.Context, canvasID uuid.UUID, n int) (int, error)

	// Users
	UpsertUserByGoogleSub(ctx context.Context, u *User) (*User, error)
	GetUserByID(ctx context.Context, id uuid.UUID) (*User, error)
	// GetUserByEmail powers share-by-email; returns ErrUserNotFound when no
	// account uses that address (they must have signed in at least once).
	GetUserByEmail(ctx context.Context, email string) (*User, error)
	// UpdateUserDefaultVisibility sets the user's default_canvas_visibility
	// preference ('public'|'private') and returns the refreshed row.
	UpdateUserDefaultVisibility(ctx context.Context, id uuid.UUID, visibility string) (*User, error)
	// UpdateUserDefaultPublicRole sets the user's default_public_role preference
	// ('read'|'write') and returns the refreshed row.
	UpdateUserDefaultPublicRole(ctx context.Context, id uuid.UUID, role string) (*User, error)
	// UpdateUserAgentFollowStyle sets the user's agent_follow_style preference
	// ('cinematic'|'minimal') and returns the refreshed row.
	UpdateUserAgentFollowStyle(ctx context.Context, id uuid.UUID, style string) (*User, error)
	// DeleteUserAccount permanently removes a user account: first every canvas
	// they OWN (each canvas's content, access rows, and notifications cascade
	// per-canvas, exactly like DeleteCanvas), then the user row itself — which
	// cascades their memberships on OTHER people's canvases (canvas_access),
	// their notification inbox, personal access tokens, and OAuth codes/grants
	// (all FK users ON DELETE CASCADE). Two statements because
	// canvases.owner_user_id is ON DELETE SET NULL (migration 0017): deleting
	// only the user row would orphan owned canvases back to anonymous instead
	// of removing them.
	DeleteUserAccount(ctx context.Context, userID uuid.UUID) error

	// Personal access tokens (migration 0027) — user-scoped MCP credentials.
	// CreatePersonalAccessToken stores the hash and returns the metadata row;
	// the plaintext is generated + returned by the caller (never persisted).
	CreatePersonalAccessToken(ctx context.Context, userID uuid.UUID, name, tokenHash, lastFour string) (*PersonalAccessToken, error)
	ListPersonalAccessTokens(ctx context.Context, userID uuid.UUID) ([]*PersonalAccessToken, error)
	// DeletePersonalAccessToken revokes a token; scoped to userID so a caller can
	// only revoke their own. Returns ErrInvalidToken if no such row for the user.
	DeletePersonalAccessToken(ctx context.Context, userID, id uuid.UUID) error
	// UserIDByTokenHash resolves the owning user from a token hash and touches
	// last_used_at. Returns ErrInvalidToken when no live token matches.
	UserIDByTokenHash(ctx context.Context, tokenHash string) (uuid.UUID, error)

	// OAuth 2.1 authorization server (migration 0029).
	CreateOAuthClient(ctx context.Context, c *OAuthClient) error
	GetOAuthClient(ctx context.Context, id string) (*OAuthClient, error)
	// CreateAuthCode stores a pending authorization code (by its hash).
	CreateAuthCode(ctx context.Context, codeHash string, c *OAuthCode) error
	// ConsumeAuthCode atomically fetches and deletes a code (single use).
	// Returns ErrInvalidGrant when missing/already used.
	ConsumeAuthCode(ctx context.Context, codeHash string) (*OAuthCode, error)
	// CreateOAuthGrant persists an issued token pair (hashes + metadata).
	CreateOAuthGrant(ctx context.Context, accessHash, refreshHash string, g *OAuthGrant) error
	// OAuthUserByAccessHash resolves the user + client_id from a live access-token
	// hash (not expired, not revoked) and touches last_used_at. Returns
	// ErrInvalidToken otherwise. The client_id lets callers stamp a grant binding
	// onto issued canvas tokens (see HasLiveOAuthGrant).
	OAuthUserByAccessHash(ctx context.Context, accessHash string) (uuid.UUID, string, error)
	// HasLiveOAuthGrant reports whether the user still holds any non-revoked token
	// for the client — i.e. the connection hasn't been disconnected from /me. Used
	// to invalidate canvas tokens minted off a since-revoked OAuth session before
	// their TTL elapses.
	HasLiveOAuthGrant(ctx context.Context, userID uuid.UUID, clientID string) (bool, error)
	// ConsumeRefreshGrant validates a refresh-token hash (live), revokes the old
	// grant, and returns its metadata so the caller can mint a rotated pair.
	// Returns ErrInvalidGrant when missing/expired/revoked.
	ConsumeRefreshGrant(ctx context.Context, refreshHash string) (*OAuthGrant, error)
	// ListOAuthConnections lists the user's active authorizations (one per client)
	// for the "connected apps" UI.
	ListOAuthConnections(ctx context.Context, userID uuid.UUID) ([]*OAuthConnection, error)
	// RevokeOAuthConnection revokes every live token the user holds for a client
	// (disconnect). Returns ErrInvalidGrant if there was nothing to revoke.
	RevokeOAuthConnection(ctx context.Context, userID uuid.UUID, clientID string) error

	// Pending edits
	CreatePendingEdit(ctx context.Context, canvasID uuid.UUID, entityID uuid.UUID, instruction string) (*PendingEdit, error)
	DeletePendingEdit(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) error
	ListPendingEdits(ctx context.Context, canvasID uuid.UUID) ([]*PendingEdit, error)

	Close()
}
