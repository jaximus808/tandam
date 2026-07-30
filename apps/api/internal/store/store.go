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
	// ErrWebhookNotFound is returned by the webhook config reads/mutations when
	// the id doesn't resolve to a webhook on the canvas (migration 0038).
	ErrWebhookNotFound = errors.New("webhook not found")
	// ErrWebhookDeliveryNotRetryable is returned by RetryWebhookDelivery when
	// the conditional re-queue matched no row: the id isn't a delivery on this
	// canvas, or it is but its status isn't one the human retry button applies
	// to ('failed' and 'dead' are the only two — see the method's doc).
	ErrWebhookDeliveryNotRetryable = errors.New("webhook delivery not found or not retryable")
	// ErrIllegalActionState wraps a ClaimAction/ReleaseAction that matched no
	// row because the action is in a state the transition doesn't apply to
	// (e.g. claiming a task still in 'proposed').
	ErrIllegalActionState = errors.New("illegal action state transition")
	// ErrContentLocked wraps a content edit (title/body) refused because the
	// action is terminal — done or failed. See content_gate.go: an approved task
	// that is edited re-enters the gate, but a FINISHED one is history, and
	// history is not rewritten.
	ErrContentLocked = errors.New("task content is locked")
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

// ClaimOutcome describes HOW a successful ClaimAction was won, beyond the
// action itself. It exists because claim expiry in this system is LAZY: there is
// no sweeper that walks stale claims (see DefaultClaimTTL), so the only moment a
// lapsed claim is observable is the instant a rival claimer takes it over inside
// ClaimAction. Without this the API layer cannot distinguish "claimed a queued
// task" from "expired someone's claim and took the task", and the
// task.claim_expired webhook (TDM-37) would have nothing to fire on.
//
// It replaces the bare version int the claim used to return — every caller
// ignored that value, so folding it into a named struct costs nothing and gives
// the takeover facts a place to live.
type ClaimOutcome struct {
	// Version is the canvas version after the claim (0 when nothing bumped).
	Version int
	// ExpiredClaimBy names the holder whose claim had lapsed and was taken over
	// by this claim. Empty on an ordinary claim of an 'approved' task.
	//
	// Deliberately empty for a SELF-takeover (the same named agent restamping
	// its own expired claim): the TTL lapsed, but the task never changed hands
	// and the agent is demonstrably alive, so there is no handoff to report.
	ExpiredClaimBy string
	// ExpiredClaimAt is when the lapsed claim was originally taken. Zero unless
	// ExpiredClaimBy is set.
	ExpiredClaimAt time.Time
	// ClaimGeneration is THIS lease's fencing token (TDM-98): the per-task claim
	// counter, incremented by every claim that stamps a fresh lease and never
	// reset. The claimant presents it on later writes and the server refuses any
	// write whose generation is not the live one — so a worker whose lease lapsed
	// cannot complete a task that has since changed hands (and back again).
	//
	// 0 means no token: the stamp write did not land, or the store does not mint
	// them. Callers must treat 0 as "fence on holder identity alone", never as a
	// valid generation. See store/claim_fence.go for the full rationale.
	ClaimGeneration int
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
	Visibility string `json:"visibility,omitempty"`
	PublicRole string `json:"publicRole,omitempty"`
	YourRole   string `json:"yourRole,omitempty"`
	// ApprovalPolicy ('strict'|'epic'|'auto', migration 0033) sets how much human
	// gating agent-proposed tasks get. Empty (legacy row) is treated as 'epic',
	// the DB default. Enforced in the action create/approve handlers.
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
	// BriefingDocID is the document designated as this canvas's briefing — the
	// read-me-first context an agent pulls on connect (migration 0037). At most
	// one per canvas by construction. nil = no briefing designated.
	BriefingDocID *uuid.UUID `json:"briefingDocId,omitempty"`
	Version       int        `json:"version"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
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
	// AuthoredBy is server-derived provenance (migration 0039): "human" |
	// "agent:<identity>" | "anonymous", stamped on INSERT from the request's
	// auth context and NEVER read off the request body. nil = the row predates
	// provenance. Unlike CreatedBy, a client cannot set or change it.
	AuthoredBy *string   `json:"authoredBy,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
	// Freshness pair (migration 0037). VerifiedAt is when someone last asserted
	// this content is still TRUE — not when the bytes last changed (that's
	// UpdatedAt). StaleAfterSeconds is how long that assertion stays good. Both
	// nil-able; status is derived, never stored — see DeriveFreshness.
	VerifiedAt        *time.Time `json:"verifiedAt,omitempty"`
	StaleAfterSeconds *int       `json:"staleAfterSeconds,omitempty"`
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
	// Freshness pair (migration 0037) — see Note.VerifiedAt.
	VerifiedAt        *time.Time `json:"verifiedAt,omitempty"`
	StaleAfterSeconds *int       `json:"staleAfterSeconds,omitempty"`
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
	ID         uuid.UUID       `json:"id"`
	Kind       string          `json:"kind"` // always "action"
	Type       string          `json:"type"`
	State      string          `json:"state"`
	Payload    json.RawMessage `json:"payload"`
	ProposedBy string          `json:"proposedBy"`
	ApprovedBy *string         `json:"approvedBy,omitempty"`
	// ClaimedBy/ClaimedAt record which agent holds the executing claim (set by
	// ClaimAction, cleared by ReleaseAction). Migration 0032.
	ClaimedBy    *string     `json:"claimedBy,omitempty"`
	ClaimedAt    *time.Time  `json:"claimedAt,omitempty"`
	Result       *string     `json:"result,omitempty"`
	Error        *string     `json:"error,omitempty"`
	LinkedPinIDs []uuid.UUID `json:"linkedPinIds"`
	// Ticket is the per-canvas sequential task number (type "task" only; nil
	// for other action types). Only the integer is stored — the "TDM-<n>"
	// display form is added at serialization time (see MarshalJSON).
	Ticket *int `json:"ticket,omitempty"`
	// AuthoredBy is server-derived provenance (migration 0039): "human" |
	// "agent:<identity>" | "anonymous", stamped on INSERT from the request's
	// auth context and NEVER read off the request body. nil = the row predates
	// provenance. Unlike ProposedBy — a freeform label the caller sends — this
	// one cannot be spoofed into claiming a human wrote the task.
	AuthoredBy *string   `json:"authoredBy,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// TicketID renders a stored ticket integer as the display form humans and
// webhook receivers see. One definition, because the string is an identifier
// people paste around ("TDM-37") — an API response and a webhook payload
// disagreeing on its spelling would be a quiet, confusing bug.
func TicketID(n int) string { return fmt.Sprintf("TDM-%d", n) }

// MarshalJSON adds the ticket's display form ("TDM-<n>", as ticketId) to every
// serialization of an Action — REST responses and WS state broadcasts alike —
// while the DB stores only the integer.
func (a *Action) MarshalJSON() ([]byte, error) {
	type actionAlias Action // alias sheds the method, avoiding recursion
	out := struct {
		*actionAlias
		TicketID string `json:"ticketId,omitempty"`
	}{actionAlias: (*actionAlias)(a)}
	out.TicketID = a.TicketID()
	return json.Marshal(out)
}

// TicketID is the display form of the stored ticket integer ("TDM-<n>"), or ""
// when the action has no ticket (non-task types, and tasks created before
// migration 0034). The one place the prefix lives, so the wire format and any
// server-side rendering (context_get's markdown) can't drift apart.
func (a *Action) TicketID() string {
	if a == nil || a.Ticket == nil {
		return ""
	}
	return TicketID(*a.Ticket)
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
	// Freshness pair (migration 0037), carried through from the source row so a
	// hydrated link can be annotated with its derived freshness. Linked context is
	// exactly the material an agent cites verbatim, so it is the last place rot
	// should be invisible — see DeriveFreshness.
	VerifiedAt        *time.Time `json:"verifiedAt,omitempty"`
	StaleAfterSeconds *int       `json:"staleAfterSeconds,omitempty"`
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
	// CreatedAt is when this identity first registered on the canvas — the
	// "member since" half of presence, next to LastSeenAt's "still alive".
	// Zero on the cheap summary read, which selects only id+name.
	CreatedAt  time.Time `json:"createdAt,omitempty"`
	LastSeenAt time.Time `json:"lastSeen"`
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
	CreatedAt        time.Time `json:"createdAt"`
	LastSeenAt       time.Time `json:"lastSeenAt"`
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

// ── Outbound webhooks (migration 0038) ───────────────────────────────────────

// Webhook is one per-canvas outbound endpoint config. Human-set from the web UI
// only — there is deliberately no MCP surface, so an agent can't point a canvas
// at an endpoint it controls.
//
// Secret is the HMAC-SHA256 key, stored in plaintext (it has to be: signing
// needs the key material, so there is nothing to compare a hash against). It is
// `json:"-"` so it can NEVER ride an API response by accident — the read paths
// that back the UI (ListWebhooks/GetWebhook) don't even select the column, and
// SecretLastFour is what the config list shows instead. Only
// ListWebhooksForEvent — the emit/deliver path — populates it.
type Webhook struct {
	ID       uuid.UUID `json:"id"`
	CanvasID uuid.UUID `json:"canvasId"`
	URL      string    `json:"url"`
	Secret   string    `json:"-"`
	// SecretLastFour is the trailing 4 chars of the secret, the only part of it
	// any read path exposes (enough to tell two configs apart in the UI).
	SecretLastFour string    `json:"secretLastFour,omitempty"`
	Events         []string  `json:"events"`
	Enabled        bool      `json:"enabled"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	CreatedBy      string    `json:"createdBy"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// WantsEvent reports whether this webhook's event filter selects eventType.
// The DB-side equivalent is `events @> ARRAY[eventType]`; this is the in-Go
// mirror used by tests and by any caller holding an already-loaded config.
func (w *Webhook) WantsEvent(eventType string) bool {
	for _, e := range w.Events {
		if e == eventType {
			return true
		}
	}
	return false
}

// WebhookPatch is a partial update of a webhook config. nil fields are left
// unchanged; a non-nil Secret rotates the key (a plain column UPDATE — the
// receiver briefly sees signatures it can't verify, which migration 0038
// accepts at this scale).
type WebhookPatch struct {
	URL         *string   `json:"url"`
	Secret      *string   `json:"-"`
	Events      *[]string `json:"events"`
	Enabled     *bool     `json:"enabled"`
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
}

// WebhookDelivery is one attemptable delivery: the row a worker leases, sends,
// and retries in place. See migration 0038 for the identifier contract —
// briefly: ID is the DELIVERY id (stable across retries, sent as
// Tandem-Delivery-Id so a receiver can dedupe), EventID is the SOURCE-EVENT id
// shared by every row fanned out from one canvas event.
//
// LastAttemptAt is stamped when an attempt STARTS (at lease time), so it also
// serves as the lease clock: a 'delivering' row older than the lease timeout was
// abandoned by a crashed worker and is reaped back to 'failed'.
type WebhookDelivery struct {
	ID        uuid.UUID       `json:"id"`
	WebhookID uuid.UUID       `json:"webhookId"`
	CanvasID  uuid.UUID       `json:"canvasId"`
	EventID   uuid.UUID       `json:"eventId"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
	// Status ∈ pending | delivering | ok | failed | dead. 'ok' and 'dead' are
	// terminal; 'dead' IS the dead letter.
	Status         string     `json:"status"`
	AttemptCount   int        `json:"attemptCount"`
	LastAttemptAt  *time.Time `json:"lastAttemptAt,omitempty"`
	NextAttemptAt  time.Time  `json:"nextAttemptAt"`
	ResponseStatus *int       `json:"responseStatus,omitempty"`
	ResponseBody   string     `json:"responseBody,omitempty"`
	Error          string     `json:"error,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
}

// WebhookDeliveryResult is the outcome of one attempt, written back by the
// worker. ResponseStatus is nil when the request never got a response (DNS,
// TLS, timeout, or a blocked SSRF target).
type WebhookDeliveryResult struct {
	ResponseStatus *int
	ResponseBody   string
	Error          string
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
	// AuthoredBy is server-derived provenance (migration 0039): "human" |
	// "agent:<identity>" | "anonymous", stamped on INSERT from the request's
	// auth context and NEVER read off the request body. nil = the row predates
	// provenance (or, today, was minted as the backing document of a sheet —
	// see CreateSheet).
	AuthoredBy *string   `json:"authoredBy,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
	// Freshness pair (migration 0037) — see Note.VerifiedAt. On a document this
	// vouches for the doc as a whole (the briefing doc is the motivating case).
	VerifiedAt        *time.Time `json:"verifiedAt,omitempty"`
	StaleAfterSeconds *int       `json:"staleAfterSeconds,omitempty"`
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
	FreshnessPatch
}

// FreshnessPatch is the freshness half of an update, shared verbatim by the
// note / roadmap-item / document patches (migration 0037). nil value + false
// clear = column untouched; the explicit Clear flags exist because a nil
// pointer can't distinguish "leave it" from "null it out" — same reason
// EventPatch carries ClearEnd/ClearCost. Embedded rather than repeated so the
// three patches can't drift, and so applyFreshnessPatch has one shape to apply.
//
// Verifying is deliberately its own act, separate from editing: a patch that
// only changes Body leaves VerifiedAt alone, so fixing a typo never
// re-certifies content nobody re-read.
type FreshnessPatch struct {
	VerifiedAt             *time.Time `json:"verifiedAt"`
	StaleAfterSeconds      *int       `json:"staleAfterSeconds"`
	ClearVerifiedAt        bool       `json:"clearVerifiedAt"`
	ClearStaleAfterSeconds bool       `json:"clearStaleAfterSeconds"`
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
	FreshnessPatch
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
	FreshnessPatch
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
	// SetCanvasBriefingDoc designates (or, with a nil docID, un-designates) the
	// canvas's briefing document (migration 0037). The FK enforces that the id
	// is a real document; the caller checks it belongs to THIS canvas.
	SetCanvasBriefingDoc(ctx context.Context, canvasID uuid.UUID, docID *uuid.UUID) (int, error)
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
	// ListNotesByDocument returns one document's notes in sort order — the
	// document's body, in reading order. Exists so context_get (E1.3) can render
	// the designated briefing document without loading every note on the canvas:
	// the alternative (GetCanvasKinds with "notes") pulls the whole board's notes
	// plus a canvas row and pending edits to answer a question about one document.
	ListNotesByDocument(ctx context.Context, canvasID, documentID uuid.UUID) ([]*Note, error)

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
	// ListAgents returns every registered agent on a canvas, oldest first — the
	// roster behind GET /api/canvas/agents. Deliberately NOT a join with
	// actions: the handler pairs agents with their in-flight claims in memory
	// (one extra ListActions call), so this stays one flat round trip and the
	// join logic sits where it can also account for UNREGISTERED claimants.
	ListAgents(ctx context.Context, canvasID uuid.UUID) ([]*Agent, error)
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
	// GetActionByTicket looks a task up by its per-canvas ticket number (the "21"
	// of "TDM-21"), so callers holding the identifier humans and commit messages
	// use don't have to list the board to find the uuid. Tickets are unique per
	// canvas (reserve_task_tickets, migration 0034); a non-task action has none
	// and is therefore never returned here.
	GetActionByTicket(ctx context.Context, canvasID uuid.UUID, ticket int) (*Action, error)
	ListActions(ctx context.Context, canvasID uuid.UUID, stateFilter, typeFilter, assigneeFilter string) ([]*Action, error)
	UpdateActionState(ctx context.Context, canvasID, id uuid.UUID, patch ActionStatePatch) (int, error)
	// ClaimAction atomically claims an approved action for claimedBy — a single
	// conditional UPDATE (… WHERE state='approved') decides the winner in the DB,
	// so two concurrent task_starts can't both win. An 'executing' claim older
	// than the claim TTL (lazy expiry, no sweeper; see store.DefaultClaimTTL /
	// WithClaimTTL, 0 disables) is atomically taken over by a second conditional
	// UPDATE (… WHERE state='executing' AND claimed_at < cutoff), restamping
	// claimed_by/claimed_at. Returns the claimed action + a ClaimOutcome (new
	// canvas version, and whether this claim expired a previous holder),
	// ErrActionNotFound, *AlreadyClaimedError (with the current holder — the
	// NEW one if a takeover race was lost), or an ErrIllegalActionState-wrapped
	// error for other states.
	ClaimAction(ctx context.Context, canvasID, id uuid.UUID, claimedBy string) (*Action, ClaimOutcome, error)
	// TouchActionClaim refreshes the claim lease on an executing task —
	// restamping claimed_at to now — so a worker that is alive and reporting
	// progress cannot be reclaimed out from under itself once its ORIGINAL claim
	// passes the TTL (TDM-64). HOLDER-ONLY: the conditional UPDATE carries a
	// claimed_by predicate, so nobody can extend a claim they don't hold.
	// Returns the restamped action and ok=true when the lease moved; ok=false
	// (nil error) when nothing matched — not executing, not this holder, gone.
	// Best-effort by contract: the caller must not fail a report over it.
	TouchActionClaim(ctx context.Context, canvasID, id uuid.UUID, claimedBy string) (*Action, bool, error)
	// ReleaseAction frees a stuck claim: executing → approved, clearing
	// claimed_by/claimed_at, via the same conditional-UPDATE pattern. Human-only —
	// the gate lives at the route surface (see api.ReleaseAction).
	ReleaseAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, int, error)
	// RequeueAction sends a FAILED task back to the queue: failed → approved,
	// clearing claimed_by/claimed_at and error, via the same conditional-UPDATE
	// pattern. Human-only — the gate lives at the route surface (see
	// api.RequeueAction); agents must not requeue their own failures.
	RequeueAction(ctx context.Context, canvasID, id uuid.UUID) (*Action, int, error)
	// ReopenAction is the human REWIND out of a state a task cannot leave on its
	// own: done → approved (reopen a task that wasn't really finished) and
	// rejected → proposed (reconsider something triaged away). Same
	// conditional-UPDATE + re-read-to-disambiguate pattern as
	// ReleaseAction/RequeueAction, predicated on `from`, so a task that moved
	// under the request yields ErrIllegalActionState instead of a lost update.
	//
	// The claim, result and error are cleared: a task back in the queue must not
	// advertise the outcome of a life it is about to live again (the same reason
	// RequeueAction clears result). A rewind to 'proposed' also clears
	// approved_by — it is going back INTO the gate, and a proposed task
	// rendering as "approved by …" is a lie.
	//
	// (from, to) is validated by the CALLER against the human move matrix (see
	// api.humanMoveTargets); this method must never be reachable with an
	// arbitrary pair from a request body. Human-only by surface, exactly like
	// release and requeue: no MCP tool maps to it.
	ReopenAction(ctx context.Context, canvasID, id uuid.UUID, from, to string) (*Action, int, error)
	// AppendActionAudit appends ONE server-authored entry to an action's
	// payload.audit[] log and returns the stored payload. Unlike
	// UpdateActionPayload it takes no caller payload at all — it exists for the
	// entries the SERVER writes about its own state moves (see
	// NewStateAudit), which UpdateActionPayload cannot express because it
	// deliberately discards any audit[] that arrives with a payload.
	//
	// Touches nothing but `audit`, so it never trips the content gate and never
	// bumps a task out of its state. Best-effort by contract: the callers record
	// after the move has already committed, so a failure here is logged, not
	// returned to a human who has already seen their card move.
	AppendActionAudit(ctx context.Context, canvasID, id uuid.UUID, entry ContentAudit) (json.RawMessage, error)
	// NOTE: contention telemetry (AppendContentionEvent, TDM-100) is deliberately
	// NOT a method on this interface — see api.contentionStore for why. Short
	// version: it is written from a DETACHED goroutine, and a method on Store is a
	// method every test double inherits from its nil embedded Store, which turns a
	// missing implementation into a panic on a background goroutine instead of a
	// compile error. Telemetry must not be able to crash a request path, so it is
	// an optional capability the API type-asserts for.
	// UpdateActionPayload is the ONE write path for an action's payload, and
	// therefore the place the content gate lives (TDM-41 — see content_gate.go
	// for the full rule table and its rationale). Every payload write goes
	// through it precisely so there is no ungated back door:
	//
	//   - a non-content write (progress[], links[], assignee, linkedIds …)
	//     stores as before, in any state;
	//   - a content write (title/body) on an approved/executing action REVERTS
	//     it to 'proposed', clears the claim and approved_by, and appends a
	//     server-owned audit entry — the edit re-enters the human gate;
	//   - a content write on a done/failed action returns ErrContentLocked;
	//   - a content write on proposed/rejected is allowed and audited.
	//
	// `actor` is the server-derived provenance string (api.AuthorFromCtx —
	// "human" | "agent:<id>" | "anonymous"); "" records as "unknown". The
	// revert is a conditional UPDATE predicated on the state that was read, so
	// an action that moves under an in-flight edit yields
	// ErrIllegalActionState rather than a lost update.
	UpdateActionPayload(ctx context.Context, canvasID, id uuid.UUID, payload json.RawMessage, actor string) (*ContentUpdate, error)
	DeleteAction(ctx context.Context, canvasID, id uuid.UUID) (int, error)
	// ApproveEpicTasks batch-approves every currently-proposed task under an epic
	// (actions rows with type='task', state='proposed', payload epicId = epicID)
	// in ONE bulk UPDATE, stamping approved_by (the 'policy:epic' provenance).
	// Tasks self-flagged requiresApproval:true are skipped — they keep their
	// individual human gate. Returns the tasks that actually flipped (so the
	// caller can fan one task.approved webhook out per task — TDM-37); the
	// canvas version is bumped only when that slice is non-empty.
	ApproveEpicTasks(ctx context.Context, canvasID, epicID uuid.UUID, approvedBy string) ([]*Action, error)
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

	// ── Outbound webhooks (migration 0038) ────────────────────────────────────
	// Config CRUD. The read paths deliberately do NOT select the `secret`
	// column, so a config can never leak its key through a list/read response;
	// only ListWebhooksForEvent (the emit path) loads it.
	CreateWebhook(ctx context.Context, canvasID uuid.UUID, w *Webhook) (*Webhook, error)
	ListWebhooks(ctx context.Context, canvasID uuid.UUID) ([]*Webhook, error)
	GetWebhook(ctx context.Context, canvasID, id uuid.UUID) (*Webhook, error)
	UpdateWebhook(ctx context.Context, canvasID, id uuid.UUID, patch WebhookPatch) (*Webhook, error)
	DeleteWebhook(ctx context.Context, canvasID, id uuid.UUID) error
	// CountWebhooks backs the app-enforced per-canvas cap (migration 0038
	// deliberately has no DB-level limit).
	CountWebhooks(ctx context.Context, canvasID uuid.UUID) (int, error)
	// ListWebhooksForEvent returns the ENABLED webhooks on a canvas whose event
	// filter contains eventType (`events @> ARRAY[eventType]`), WITH their
	// secrets — the fan-out read behind Emit. The only method that loads a
	// secret; never hand its results to a response writer.
	ListWebhooksForEvent(ctx context.Context, canvasID uuid.UUID, eventType string) ([]*Webhook, error)
	// GetWebhookWithSecret loads one config by id, WITH its secret — the
	// delivery worker's lookup (a leased delivery row carries neither the target
	// URL nor the key). Not canvas-scoped, because the worker leases across
	// canvases; authorization for it is "you are the worker". Same warning as
	// ListWebhooksForEvent: never hand the result to a response writer.
	GetWebhookWithSecret(ctx context.Context, id uuid.UUID) (*Webhook, error)

	// Delivery queue. CreateWebhookDeliveries is the fan-out insert: one row per
	// matching webhook, all carrying the SAME event_id, which combined with
	// UNIQUE(webhook_id, event_id) makes a re-run of the same source event a
	// no-op instead of a duplicate notification. Returns how many rows were new.
	CreateWebhookDeliveries(ctx context.Context, deliveries []*WebhookDelivery) (int, error)
	// LeaseWebhookDeliveries atomically claims up to limit due deliveries
	// (status pending|failed AND next_attempt_at <= now), flipping them to
	// 'delivering', stamping last_attempt_at = now (the lease clock) and
	// incrementing attempt_count. Rows come back with attempt_count ALREADY
	// including the attempt about to be made.
	LeaseWebhookDeliveries(ctx context.Context, limit int) ([]*WebhookDelivery, error)
	// MarkWebhookDeliveryOK / Failed / Dead close out a leased attempt. Failed
	// schedules the retry (status 'failed' + next_attempt_at); Dead is terminal
	// (budget spent, or a non-retryable rejection).
	MarkWebhookDeliveryOK(ctx context.Context, id uuid.UUID, res WebhookDeliveryResult) error
	MarkWebhookDeliveryFailed(ctx context.Context, id uuid.UUID, nextAttemptAt time.Time, res WebhookDeliveryResult) error
	MarkWebhookDeliveryDead(ctx context.Context, id uuid.UUID, res WebhookDeliveryResult) error
	// ReapStuckWebhookDeliveries pushes 'delivering' rows whose lease clock
	// (last_attempt_at) is older than olderThan back to 'failed' so they retry —
	// the recovery path for a worker that died mid-flight. Returns the count.
	ReapStuckWebhookDeliveries(ctx context.Context, olderThan time.Duration) (int, error)
	// ListWebhookDeliveries backs the UI history + dead-letter lists: newest
	// first, optionally narrowed to one webhook and/or one status ("dead" for
	// the dead-letter list; "" for all).
	ListWebhookDeliveries(ctx context.Context, canvasID uuid.UUID, webhookID *uuid.UUID, status string, limit int) ([]*WebhookDelivery, error)
	// RetryWebhookDelivery re-queues one dead-lettered (or waiting-to-retry)
	// delivery: status back to 'pending', next_attempt_at = now, and a FRESH
	// attempt budget. Canvas-scoped, because it is reachable from the human
	// dead-letter list in the web UI. Returns ErrWebhookDeliveryNotRetryable
	// when nothing matched.
	RetryWebhookDelivery(ctx context.Context, canvasID, id uuid.UUID) (*WebhookDelivery, error)

	// Pending edits
	CreatePendingEdit(ctx context.Context, canvasID uuid.UUID, entityID uuid.UUID, instruction string) (*PendingEdit, error)
	DeletePendingEdit(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) error
	ListPendingEdits(ctx context.Context, canvasID uuid.UUID) ([]*PendingEdit, error)

	Close()
}
