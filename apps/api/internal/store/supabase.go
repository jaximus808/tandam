package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	supa "github.com/supabase-community/supabase-go"
)

// Ambiguous glyphs (0/O, 1/I/L) intentionally excluded so codes are easy to
// dictate over voice/chat. Length 8 over this 32-char alphabet → 32^8 ≈ 1.1e12
// keyspace, which is what makes brute-forcing the canvas code (our only auth)
// infeasible — provided the generator is unpredictable. Hence crypto/rand.
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateCode() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is a kernel-level problem; we'd rather refuse
		// to issue a guessable code than silently fall back to math/rand.
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	out := make([]byte, 8)
	for i, x := range b {
		out[i] = codeChars[int(x)%len(codeChars)]
	}
	return string(out)
}

// generateClaimToken mints a private "own this canvas" token. Its format is
// deliberately distinct from a canvas code (see migration 0020): a "clm_" prefix
// plus 32 lowercase hex chars. Different prefix, length, alphabet, and case mean
// a code can never be mistaken for or collide with a token. 16 bytes = 128 bits
// of entropy, appropriate for an unguessable bearer secret (vs. the code's ~40
// bits, which only gates view access). crypto/rand for the same reason as codes.
func generateClaimToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	return "clm_" + hex.EncodeToString(b)
}

// PATPrefix namespaces personal access tokens. Prefix-gating on this string lets
// the auth middleware skip a DB lookup for any bearer that isn't a PAT, and keeps
// PATs unmistakable for canvas codes ('clm_' claim tokens, 8-char codes).
const PATPrefix = "tdm_pat_"

// GeneratePAT mints a user's personal access token: PATPrefix + 32 random bytes
// (hex) = 256 bits of entropy, appropriate for a long-lived bearer secret.
// crypto/rand for the same reason as codes/claim tokens.
func GeneratePAT() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("crypto/rand: %w", err))
	}
	return PATPrefix + hex.EncodeToString(b)
}

// HashToken returns the hex SHA-256 of a token. We store only this hash, so a DB
// leak can't yield usable tokens; auth hashes the presented secret and matches.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// LastFour returns the trailing 4 chars of a token, kept for UI disambiguation.
func LastFour(token string) string {
	if len(token) <= 4 {
		return token
	}
	return token[len(token)-4:]
}

// ── DB row types (snake_case = Supabase column names) ─────────────────────────

type dbCanvas struct {
	ID           string          `json:"id"`
	Code         string          `json:"code"`
	Name         string          `json:"name"`
	Mode         string          `json:"mode"`
	MapID        *string         `json:"map_id"`
	OwnerUserID  *string         `json:"owner_user_id"`
	ClaimToken   *string         `json:"claim_token"`
	Visibility   string          `json:"visibility"`
	PublicRole   string          `json:"public_role"`
	EnabledModes json.RawMessage `json:"enabled_modes"`
	Version      int             `json:"version"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
}

type dbPin struct {
	ID         string  `json:"id"`
	DocumentID *string `json:"document_id"`
	PinType    string  `json:"pin_type"`
	Lat        float64 `json:"lat"`
	Lng        float64 `json:"lng"`
	Label      *string `json:"label"`
	Body       *string `json:"body"`
	Color      *string `json:"color"`
	CreatedBy  string  `json:"created_by"`
	UpdatedAt  string  `json:"updated_at"`
}

type dbEvent struct {
	ID         string   `json:"id"`
	DocumentID *string  `json:"document_id"`
	Title      string   `json:"title"`
	StartTime  string   `json:"start_time"`
	EndTime    *string  `json:"end_time"`
	Timezone   *string  `json:"timezone"`
	PinIDs     []string `json:"pin_ids"`
	PinID      *string  `json:"pin_id"`
	FromPinID  *string  `json:"from_pin_id"`
	ToPinID    *string  `json:"to_pin_id"`
	TravelMode *string  `json:"travel_mode"`
	DayTag     *string  `json:"day_tag"`
	Cost       *float64 `json:"cost"`
	CreatedBy  string   `json:"created_by"`
	UpdatedAt  string   `json:"updated_at"`
}

type dbNote struct {
	ID         string   `json:"id"`
	DocumentID *string  `json:"document_id"`
	Body       string   `json:"body"`
	ImageRefs  []string `json:"image_refs"`
	ParentID   *string  `json:"parent_id"`
	ParentKind *string  `json:"parent_kind"`
	SortOrder  int      `json:"sort_order"`
	CreatedBy  string   `json:"created_by"`
	UpdatedAt  string   `json:"updated_at"`
}

type dbRoadmapItem struct {
	ID         string  `json:"id"`
	DocumentID *string `json:"document_id"`
	ParentID   *string `json:"parent_id"`
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	Status     string  `json:"status"`
	Stage      *string `json:"stage"`
	Assignee   *string `json:"assignee"`
	SortOrder  int     `json:"sort_order"`
	CreatedBy  string  `json:"created_by"`
	UpdatedAt  string  `json:"updated_at"`
}

type dbSheet struct {
	ID         string          `json:"id"`
	DocumentID *string         `json:"document_id"`
	Name       string          `json:"name"`
	Columns    json.RawMessage `json:"columns"`
	SortOrder  int             `json:"sort_order"`
	CreatedBy  string          `json:"created_by"`
	UpdatedAt  string          `json:"updated_at"`
	// sheet_rows is FK'd to sheets (no canvas_id), so PostgREST embeds rows
	// nested here under each sheet — NOT as a top-level table on the canvas.
	SheetRows []dbSheetRow `json:"sheet_rows"`
}

type dbSheetRow struct {
	ID        string          `json:"id"`
	SheetID   string          `json:"sheet_id"`
	Data      json.RawMessage `json:"data"`
	SortOrder int             `json:"sort_order"`
	CreatedBy string          `json:"created_by"`
	UpdatedAt string          `json:"updated_at"`
}

type dbChart struct {
	ID         string          `json:"id"`
	DocumentID *string         `json:"document_id"`
	Name       string          `json:"name"`
	SheetID    string          `json:"sheet_id"`
	ChartType  string          `json:"chart_type"`
	XColumn    string          `json:"x_column"`
	YColumns   json.RawMessage `json:"y_columns"`
	SortOrder  int             `json:"sort_order"`
	CreatedBy  string          `json:"created_by"`
	UpdatedAt  string          `json:"updated_at"`
}

type dbForm struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Fields      json.RawMessage `json:"fields"`
	Actions     json.RawMessage `json:"actions"`
	SortOrder   int             `json:"sort_order"`
	CreatedBy   string          `json:"created_by"`
	UpdatedAt   string          `json:"updated_at"`
}

type dbAction struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	State        string          `json:"state"`
	Payload      json.RawMessage `json:"payload"`
	ProposedBy   string          `json:"proposed_by"`
	ApprovedBy   *string         `json:"approved_by"`
	Result       *string         `json:"result"`
	Error        *string         `json:"error"`
	LinkedPinIDs json.RawMessage `json:"linked_pin_ids"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
}

type dbAgent struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Role       string  `json:"role"`
	Model      *string `json:"model"`
	Status     string  `json:"status"`
	LastSeenAt string  `json:"last_seen_at"`
}

type dbUser struct {
	ID                      string `json:"id"`
	GoogleSub               string `json:"google_sub"`
	Email                   string `json:"email"`
	DisplayName             string `json:"display_name"`
	AvatarURL               string `json:"avatar_url"`
	DefaultCanvasVisibility string `json:"default_canvas_visibility"`
	DefaultPublicRole       string `json:"default_public_role"`
	CreatedAt               string `json:"created_at"`
	LastSeenAt              string `json:"last_seen_at"`
}

type dbToken struct {
	ID         string  `json:"id"`
	UserID     string  `json:"user_id"`
	Name       string  `json:"name"`
	LastFour   string  `json:"last_four"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
}

type dbPendingEdit struct {
	ID          string `json:"id"`
	EntityID    string `json:"entity_id"`
	Instruction string `json:"instruction"`
	CreatedAt   string `json:"created_at"`
}

type dbDocument struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	ParentID  *string         `json:"parent_id"`
	SortOrder int             `json:"sort_order"`
	Config    json.RawMessage `json:"config"`
	CreatedBy string          `json:"created_by"`
	UpdatedAt string          `json:"updated_at"`
}

// Used for GetCanvasState — one request with embedded child tables.
type dbCanvasWithChildren struct {
	dbCanvas
	Documents    []dbDocument    `json:"documents"`
	Pins         []dbPin         `json:"pins"`
	Events       []dbEvent       `json:"events"`
	Notes        []dbNote        `json:"notes"`
	RoadmapItems []dbRoadmapItem `json:"roadmap_items"`
	Sheets       []dbSheet       `json:"sheets"`
	// NOTE: sheet rows are NOT a top-level embed — they ride nested inside each
	// dbSheet.SheetRows (sheet_rows is FK'd to sheets, not canvases).
	Charts       []dbChart       `json:"charts"`
	Forms        []dbForm        `json:"forms"`
	Actions      []dbAction      `json:"actions"`
	Agents       []dbAgent       `json:"agents"`
	PendingEdits []dbPendingEdit `json:"pending_edits"`
}

// ── Converters ────────────────────────────────────────────────────────────────

func uuidStrings(ids []uuid.UUID) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.String())
	}
	return out
}

// parseUUIDPtr turns a nullable db uuid string into *uuid.UUID, tolerating nil,
// empty, and unparseable values (all → nil). Used for the many nullable FKs
// (document_id, parent_id, …).
func parseUUIDPtr(s *string) *uuid.UUID {
	if s == nil || *s == "" {
		return nil
	}
	if id, err := uuid.Parse(*s); err == nil {
		return &id
	}
	return nil
}

// uuidPtrStr renders a nullable uuid for an insert/update map: nil stays SQL
// NULL, a set value becomes its string form. Used for the document_id FK.
func uuidPtrStr(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return id.String()
}

func toDocument(d dbDocument) *Document {
	id, _ := uuid.Parse(d.ID)
	doc := &Document{ID: id, Kind: "document",
		Type: d.Type, Name: d.Name, SortOrder: d.SortOrder,
		ParentID:  parseUUIDPtr(d.ParentID),
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Config: map[string]any{},
	}
	if len(d.Config) > 0 {
		_ = json.Unmarshal(d.Config, &doc.Config)
	}
	return doc
}

func parseTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func toCanvas(d dbCanvas) *Canvas {
	id, _ := uuid.Parse(d.ID)
	var owner *uuid.UUID
	if d.OwnerUserID != nil && *d.OwnerUserID != "" {
		if oid, err := uuid.Parse(*d.OwnerUserID); err == nil {
			owner = &oid
		}
	}
	return &Canvas{ID: id, Code: d.Code, Name: d.Name, Mode: d.Mode,
		EnabledModes: parseEnabledModes(d.EnabledModes), MapID: d.MapID, OwnerUserID: owner,
		Visibility: d.Visibility, PublicRole: d.PublicRole, Version: d.Version,
		CreatedAt: parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt)}
}

// parseEnabledModes decodes the enabled_modes jsonb column, which is null on
// rows written before the column existed. Always returns non-nil so the field
// marshals as [] rather than null.
func parseEnabledModes(raw json.RawMessage) []string {
	modes := []string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &modes)
	}
	return modes
}

func toPin(d dbPin) *Pin {
	id, _ := uuid.Parse(d.ID)
	return &Pin{ID: id, Kind: "pin", DocumentID: parseUUIDPtr(d.DocumentID),
		PinType: d.PinType, Lat: d.Lat, Lng: d.Lng,
		Label: d.Label, Body: d.Body, Color: d.Color,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
}

func toEvent(d dbEvent) *Event {
	id, _ := uuid.Parse(d.ID)
	ev := &Event{ID: id, Kind: "event", DocumentID: parseUUIDPtr(d.DocumentID),
		Title: d.Title, Start: parseTime(d.StartTime),
		Timezone:   d.Timezone,
		TravelMode: d.TravelMode,
		DayTag:     d.DayTag,
		Cost:       d.Cost,
		CreatedBy:  d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if d.EndTime != nil {
		t := parseTime(*d.EndTime)
		ev.End = &t
	}
	if d.PinID != nil {
		pinID, err := uuid.Parse(*d.PinID)
		if err == nil {
			ev.PinID = &pinID
		}
	}
	for _, s := range d.PinIDs {
		if id, err := uuid.Parse(s); err == nil {
			ev.PinIDs = append(ev.PinIDs, id)
		}
	}
	// Canonicalize: legacy single-pin events have pin_id but no pin_ids — surface
	// them through pinIds too so readers only need to look at one field.
	if len(ev.PinIDs) == 0 && ev.PinID != nil {
		ev.PinIDs = []uuid.UUID{*ev.PinID}
	}
	if d.FromPinID != nil {
		pinID, err := uuid.Parse(*d.FromPinID)
		if err == nil {
			ev.FromPinID = &pinID
		}
	}
	if d.ToPinID != nil {
		pinID, err := uuid.Parse(*d.ToPinID)
		if err == nil {
			ev.ToPinID = &pinID
		}
	}
	return ev
}

func toNote(d dbNote) *Note {
	id, _ := uuid.Parse(d.ID)
	n := &Note{ID: id, Kind: "note", DocumentID: parseUUIDPtr(d.DocumentID),
		Body:      d.Body,
		ImageRefs: d.ImageRefs, ParentKind: d.ParentKind,
		SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if n.ImageRefs == nil {
		n.ImageRefs = []string{}
	}
	if d.ParentID != nil {
		parentID, err := uuid.Parse(*d.ParentID)
		if err == nil {
			n.ParentID = &parentID
		}
	}
	return n
}

func toRoadmapItem(d dbRoadmapItem) *RoadmapItem {
	id, _ := uuid.Parse(d.ID)
	r := &RoadmapItem{ID: id, Kind: "roadmap", DocumentID: parseUUIDPtr(d.DocumentID),
		Title: d.Title, Body: d.Body, Status: d.Status, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
	if d.Stage != nil {
		r.Stage = *d.Stage
	}
	if d.Assignee != nil {
		r.Assignee = *d.Assignee
	}
	if d.ParentID != nil {
		parentID, err := uuid.Parse(*d.ParentID)
		if err == nil {
			r.ParentID = &parentID
		}
	}
	return r
}

func toSheet(d dbSheet) *Sheet {
	id, _ := uuid.Parse(d.ID)
	s := &Sheet{ID: id, Kind: "sheet", DocumentID: parseUUIDPtr(d.DocumentID),
		Name: d.Name, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Columns: []SheetColumn{},
	}
	if len(d.Columns) > 0 {
		_ = json.Unmarshal(d.Columns, &s.Columns)
	}
	return s
}

func toChart(d dbChart) *Chart {
	id, _ := uuid.Parse(d.ID)
	sheetID, _ := uuid.Parse(d.SheetID)
	c := &Chart{ID: id, Kind: "chart", DocumentID: parseUUIDPtr(d.DocumentID),
		Name: d.Name, SheetID: sheetID, ChartType: d.ChartType,
		XColumn: d.XColumn, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		YColumns: []string{},
	}
	if len(d.YColumns) > 0 {
		_ = json.Unmarshal(d.YColumns, &c.YColumns)
	}
	return c
}

func toForm(d dbForm) *Form {
	id, _ := uuid.Parse(d.ID)
	f := &Form{ID: id, Kind: "form",
		Name: d.Name, Description: d.Description, SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Fields: []FormField{}, Actions: []FormAction{},
	}
	if len(d.Fields) > 0 {
		_ = json.Unmarshal(d.Fields, &f.Fields)
	}
	if len(d.Actions) > 0 {
		_ = json.Unmarshal(d.Actions, &f.Actions)
	}
	return f
}

func toAction(d dbAction) *Action {
	id, _ := uuid.Parse(d.ID)
	a := &Action{ID: id, Kind: "action",
		Type: d.Type, State: d.State,
		Payload:    d.Payload,
		ProposedBy: d.ProposedBy, ApprovedBy: d.ApprovedBy,
		Result: d.Result, Error: d.Error,
		LinkedPinIDs: []uuid.UUID{},
		CreatedAt:    parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt),
	}
	if len(a.Payload) == 0 {
		a.Payload = json.RawMessage("{}")
	}
	if len(d.LinkedPinIDs) > 0 {
		var ids []string
		if err := json.Unmarshal(d.LinkedPinIDs, &ids); err == nil {
			for _, s := range ids {
				if pid, err := uuid.Parse(s); err == nil {
					a.LinkedPinIDs = append(a.LinkedPinIDs, pid)
				}
			}
		}
	}
	return a
}

func toAgent(d dbAgent) *Agent {
	id, _ := uuid.Parse(d.ID)
	return &Agent{ID: id, Kind: "agent",
		Name: d.Name, Role: d.Role, Model: d.Model, Status: d.Status,
		LastSeenAt: parseTime(d.LastSeenAt)}
}

func toSheetRow(d dbSheetRow) *SheetRow {
	id, _ := uuid.Parse(d.ID)
	sheetID, _ := uuid.Parse(d.SheetID)
	r := &SheetRow{ID: id, Kind: "sheetRow", SheetID: sheetID,
		SortOrder: d.SortOrder,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt),
		Data: map[string]any{},
	}
	if len(d.Data) > 0 {
		_ = json.Unmarshal(d.Data, &r.Data)
	}
	return r
}

func toUser(d dbUser) *User {
	id, _ := uuid.Parse(d.ID)
	return &User{
		ID: id, GoogleSub: d.GoogleSub, Email: d.Email,
		DisplayName: d.DisplayName, AvatarURL: d.AvatarURL,
		DefaultCanvasVisibility: d.DefaultCanvasVisibility,
		DefaultPublicRole:       d.DefaultPublicRole,
		CreatedAt:               parseTime(d.CreatedAt), LastSeenAt: parseTime(d.LastSeenAt),
	}
}

func toPendingEdit(d dbPendingEdit) *PendingEdit {
	id, _ := uuid.Parse(d.ID)
	entityID, _ := uuid.Parse(d.EntityID)
	return &PendingEdit{ID: id, EntityID: entityID,
		Instruction: d.Instruction, CreatedAt: parseTime(d.CreatedAt)}
}

// ── Store ─────────────────────────────────────────────────────────────────────

type supabaseStore struct {
	client *supa.Client
}

func NewSupabase(projectURL, apiKey string) (Store, error) {
	client, err := supa.NewClient(projectURL, apiKey, nil)
	if err != nil {
		return nil, fmt.Errorf("supabase client: %w", err)
	}
	return &supabaseStore{client: client}, nil
}

func (s *supabaseStore) Close() {}

// isRpcError detects a PostgREST error JSON in an Rpc() string result.
// This version of supabase-go doesn't return errors from Rpc — they come
// through as JSON objects with a "code" field.
func isRpcError(result string) bool {
	t := strings.TrimSpace(result)
	return strings.HasPrefix(t, "{") && strings.Contains(t, `"code"`)
}

func (s *supabaseStore) bumpVersion(_ context.Context, canvasID uuid.UUID) (int, error) {
	result := s.client.Rpc("bump_canvas_version", "", map[string]string{
		"canvas_id": canvasID.String(),
	})
	if result == "" {
		return 0, fmt.Errorf("bumpVersion: empty response — verify migration 0003 is applied")
	}
	if isRpcError(result) {
		return 0, fmt.Errorf("bumpVersion RPC error: %s", result)
	}
	var v int
	if err := json.Unmarshal([]byte(result), &v); err != nil {
		return 0, fmt.Errorf("bumpVersion parse: %w (response: %s)", err, result)
	}
	return v, nil
}

// exec is a convenience wrapper for mutations that don't need the response body.
func (s *supabaseStore) exec(b interface{ Execute() ([]byte, int64, error) }) error {
	_, _, err := b.Execute()
	return err
}

// ── Canvas ────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateCanvas(_ context.Context, name string, ownerUserID *uuid.UUID, visibility, publicRole string) (*Canvas, error) {
	// An anonymous create (no owner — the MCP/gateway path) gets a claim token so
	// the human can later make it theirs. A logged-in create is already owned, so
	// it needs none (NULL claim_token = "not claimable this way").
	var claimToken string
	if ownerUserID == nil {
		claimToken = generateClaimToken()
	}
	for range 10 {
		code := generateCode()
		row := map[string]any{"code": code, "name": name}
		if ownerUserID != nil {
			row["owner_user_id"] = ownerUserID.String()
		} else {
			row["claim_token"] = claimToken
		}
		// Owner's default posture. Empty = accept the column defaults ('public' /
		// 'write'), which keeps anonymous/MCP creates fully open as before.
		if visibility != "" {
			row["visibility"] = visibility
		}
		if publicRole != "" {
			row["public_role"] = publicRole
		}
		var rows []dbCanvas
		_, err := s.client.From("canvases").
			Insert(row, false, "", "representation", "").
			ExecuteTo(&rows)
		if err != nil {
			if strings.Contains(err.Error(), "23505") {
				continue
			}
			return nil, err
		}
		if len(rows) == 0 {
			return nil, fmt.Errorf("no row returned after canvas insert")
		}
		c := toCanvas(rows[0])
		// Surface the token ONLY here, on the create response. toCanvas deliberately
		// never reads it, so every other path (read/state/list/copy) omits it.
		c.ClaimToken = claimToken
		return c, nil
	}
	return nil, fmt.Errorf("failed to generate unique canvas code after 10 attempts")
}

// ListCanvasesByOwner returns a user's owned canvases, newest-edited first.
func (s *supabaseStore) ListCanvasesByOwner(_ context.Context, ownerUserID uuid.UUID) ([]*Canvas, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("owner_user_id", ownerUserID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]*Canvas, 0, len(rows))
	for _, d := range rows {
		out = append(out, toCanvas(d))
	}
	// Newest-edited first. Sorted here (small per-user list) to avoid depending
	// on the client's order-option surface.
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// CopyCanvas deep-copies srcID into a new canvas owned by ownerUserID via the
// copy_canvas RPC (atomic). The code is generated here (canonical alphabet) and
// retried on unique-violation, matching CreateCanvas.
func (s *supabaseStore) CopyCanvas(ctx context.Context, srcID, ownerUserID uuid.UUID, name string) (*Canvas, error) {
	for range 10 {
		code := generateCode()
		result := s.client.Rpc("copy_canvas", "", map[string]string{
			"p_src":   srcID.String(),
			"p_owner": ownerUserID.String(),
			"p_name":  name,
			"p_code":  code,
		})
		if result == "" {
			return nil, fmt.Errorf("copy_canvas: empty response — verify migration 0018 is applied")
		}
		if isRpcError(result) {
			if strings.Contains(result, "23505") {
				continue // code collision — try another
			}
			return nil, fmt.Errorf("copy_canvas RPC error: %s", result)
		}
		return s.GetCanvasByCode(ctx, code)
	}
	return nil, fmt.Errorf("failed to generate unique canvas code after 10 attempts")
}

// ClaimCanvas atomically transfers an unowned canvas to ownerUserID. The single
// UPDATE ... WHERE owner_user_id IS NULL AND claim_token = ? is the whole race
// guard: only one caller can match (the row stops being unowned after the first
// success), and the token is voided in the same statement so it's single-use.
// On no-match we read the canvas back to report WHY (not found / already claimed
// / wrong token) so the caller can return a precise status.
func (s *supabaseStore) ClaimCanvas(ctx context.Context, code, claimToken string, ownerUserID uuid.UUID) (*Canvas, error) {
	code = strings.ToUpper(code)
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Update(map[string]any{
			"owner_user_id": ownerUserID.String(),
			"claim_token":   nil, // void on success — single-use
		}, "representation", "").
		Eq("code", code).
		Eq("claim_token", claimToken).
		Is("owner_user_id", "null").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 1 {
		return toCanvas(rows[0]), nil
	}
	// No row updated — disambiguate the reason from current state.
	existing, gerr := s.GetCanvasByCode(ctx, code)
	if gerr != nil {
		return nil, ErrCanvasNotFound
	}
	if existing.OwnerUserID != nil {
		return nil, ErrAlreadyClaimed
	}
	return nil, ErrInvalidClaimToken
}

// DeleteCanvas removes the canvas row; every table that FKs canvases does so with
// ON DELETE CASCADE, so all content (pins/events/notes/sheets/rows/charts/roadmap/
// forms/actions/agents/documents/pending_edits), canvas_access rows, and
// notifications are cleaned up by the DB in the same statement. Owner-only checks
// live in the handler.
func (s *supabaseStore) DeleteCanvas(_ context.Context, canvasID uuid.UUID) error {
	return s.exec(s.client.From("canvases").
		Delete("minimal", "").
		Eq("id", canvasID.String()))
}

// CanvasCount returns the total number of canvases. Uses a count=exact HEAD
// request (Select count="exact", head=true) so no rows are transferred — the
// total comes back in the Content-Range header, surfaced as Execute's int64.
func (s *supabaseStore) CanvasCount(_ context.Context) (int, error) {
	_, count, err := s.client.From("canvases").
		Select("id", "exact", true).
		Execute()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// UserCount returns the total number of registered user accounts. Same
// count=exact HEAD trick as CanvasCount — no rows transferred.
func (s *supabaseStore) UserCount(_ context.Context) (int, error) {
	_, count, err := s.client.From("users").
		Select("id", "exact", true).
		Execute()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// CanvasRecurrence returns how many canvases saw activity on a later calendar
// day than they were created (revisited), alongside the total. It's a proxy
// for "someone came back" — canvas-level, since edits carry no per-user
// identity yet, and updated_at is last-touch only, so it UNDERcounts (stays
// conservative). A full scan of created_at/updated_at, fine at current scale.
func (s *supabaseStore) CanvasRecurrence(_ context.Context) (revisited int, total int, err error) {
	var rows []struct {
		CreatedAt time.Time `json:"created_at"`
		UpdatedAt time.Time `json:"updated_at"`
	}
	if _, err = s.client.From("canvases").
		Select("created_at,updated_at", "", false).
		ExecuteTo(&rows); err != nil {
		return 0, 0, err
	}
	for _, row := range rows {
		total++
		if row.UpdatedAt.UTC().Format("2006-01-02") != row.CreatedAt.UTC().Format("2006-01-02") {
			revisited++
		}
	}
	return revisited, total, nil
}

func (s *supabaseStore) GetCanvasByCode(_ context.Context, code string) (*Canvas, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("code", strings.ToUpper(code)).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("canvas not found: %s", code)
	}
	return toCanvas(rows[0]), nil
}

func (s *supabaseStore) GetCanvasByID(_ context.Context, id uuid.UUID) (*Canvas, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("canvas not found: %s", id)
	}
	return toCanvas(rows[0]), nil
}

// ── Access control (migration 0021) ───────────────────────────────────────────

// dbCanvasAccess is a canvas_access row; `users(...)` is a PostgREST embed (the
// FK canvas_access.user_id → users.id), nil when the select doesn't ask for it.
type dbCanvasAccess struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	User   *struct {
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
		AvatarURL   string `json:"avatar_url"`
	} `json:"users"`
}

// ResolveCanvasRole — the single resolver behind both write paths. owner→write,
// explicit access row→its role, else public→public_role, else none.
func (s *supabaseStore) ResolveCanvasRole(_ context.Context, canvas *Canvas, userID *uuid.UUID) (string, error) {
	if canvas == nil {
		return "none", nil
	}
	if userID != nil {
		if canvas.OwnerUserID != nil && *canvas.OwnerUserID == *userID {
			return "write", nil
		}
		var rows []dbCanvasAccess
		_, err := s.client.From("canvas_access").
			Select("role", "", false).
			Eq("canvas_id", canvas.ID.String()).
			Eq("user_id", userID.String()).
			ExecuteTo(&rows)
		if err != nil {
			return "", err
		}
		if len(rows) > 0 {
			return rows[0].Role, nil
		}
	}
	// Anything not explicitly private is public (covers legacy/empty visibility).
	if canvas.Visibility == "private" {
		return "none", nil
	}
	role := canvas.PublicRole
	if role == "" {
		role = "write" // legacy rows pre-0021 default
	}
	return role, nil
}

func (s *supabaseStore) SetCanvasVisibility(ctx context.Context, canvasID uuid.UUID, visibility, publicRole string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"visibility": visibility, "public_role": publicRole}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	// Bump version so connected boards re-fetch state and pick up the new posture.
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) SetCanvasName(ctx context.Context, canvasID uuid.UUID, name string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"name": name}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	// Bump version so connected boards re-fetch state and pick up the new name.
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ListCanvasAccess(_ context.Context, canvasID uuid.UUID) ([]*CanvasAccess, error) {
	var rows []dbCanvasAccess
	_, err := s.client.From("canvas_access").
		Select("user_id,role,users(email,display_name,avatar_url)", "", false).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]*CanvasAccess, 0, len(rows))
	for _, d := range rows {
		uid, _ := uuid.Parse(d.UserID)
		ca := &CanvasAccess{UserID: uid, Role: d.Role}
		if d.User != nil {
			ca.Email = d.User.Email
			ca.DisplayName = d.User.DisplayName
			ca.AvatarURL = d.User.AvatarURL
		}
		out = append(out, ca)
	}
	return out, nil
}

func (s *supabaseStore) UpsertCanvasAccess(_ context.Context, canvasID, userID uuid.UUID, role string) error {
	return s.exec(s.client.From("canvas_access").
		Insert(map[string]string{
			"canvas_id": canvasID.String(),
			"user_id":   userID.String(),
			"role":      role,
		}, true, "canvas_id,user_id", "minimal", ""))
}

func (s *supabaseStore) DeleteCanvasAccess(_ context.Context, canvasID, userID uuid.UUID) error {
	return s.exec(s.client.From("canvas_access").
		Delete("minimal", "").
		Eq("canvas_id", canvasID.String()).
		Eq("user_id", userID.String()))
}

// dbSharedCanvas is a canvas_access row with the canvas it points at embedded —
// powers ListCanvasesSharedWithUser (the recipient's "shared with me" view).
type dbSharedCanvas struct {
	Role   string    `json:"role"`
	Canvas *dbCanvas `json:"canvases"`
}

func (s *supabaseStore) ListCanvasesSharedWithUser(_ context.Context, userID uuid.UUID) ([]*Canvas, error) {
	var rows []dbSharedCanvas
	_, err := s.client.From("canvas_access").
		Select("role,canvases(*)", "", false).
		Eq("user_id", userID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]*Canvas, 0, len(rows))
	for _, d := range rows {
		if d.Canvas == nil {
			continue
		}
		c := toCanvas(*d.Canvas)
		// Stamp the role this user was granted so the list can badge view/edit and
		// the board opens with the right gate — the recipient-side mirror of
		// ResolveCanvasRole's access-row branch.
		c.YourRole = d.Role
		out = append(out, c)
	}
	// Newest-edited first (small per-user list; sort here to match ListCanvasesByOwner).
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// dbNotification is a notifications row with the canvas + actor it references
// embedded. Two FKs point at users (user_id recipient, actor_user_id), so the
// actor embed is disambiguated by column: users!actor_user_id.
type dbNotification struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	CanvasID  *string `json:"canvas_id"`
	Role      *string `json:"role"`
	ReadAt    *string `json:"read_at"`
	CreatedAt string  `json:"created_at"`
	Canvas    *struct {
		Code string `json:"code"`
		Name string `json:"name"`
	} `json:"canvases"`
	Actor *struct {
		DisplayName string `json:"display_name"`
	} `json:"actor"`
}

func (s *supabaseStore) CreateNotification(_ context.Context, n *Notification) error {
	row := map[string]any{
		"user_id": n.recipientID.String(),
		"kind":    n.Kind,
	}
	if n.CanvasID != nil {
		row["canvas_id"] = n.CanvasID.String()
	}
	if n.actorID != nil {
		row["actor_user_id"] = n.actorID.String()
	}
	if n.Role != "" {
		row["role"] = n.Role
	}
	return s.exec(s.client.From("notifications").Insert(row, false, "", "minimal", ""))
}

func (s *supabaseStore) ListNotifications(_ context.Context, userID uuid.UUID, limit int) ([]*Notification, error) {
	var rows []dbNotification
	_, err := s.client.From("notifications").
		Select("id,kind,canvas_id,role,read_at,created_at,canvases(code,name),actor:users!actor_user_id(display_name)", "", false).
		Eq("user_id", userID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]*Notification, 0, len(rows))
	for _, d := range rows {
		id, _ := uuid.Parse(d.ID)
		n := &Notification{
			ID:        id,
			Kind:      d.Kind,
			Read:      d.ReadAt != nil,
			CreatedAt: parseTime(d.CreatedAt),
		}
		if d.CanvasID != nil {
			if cid, err := uuid.Parse(*d.CanvasID); err == nil {
				n.CanvasID = &cid
			}
		}
		if d.Role != nil {
			n.Role = *d.Role
		}
		if d.Canvas != nil {
			n.CanvasCode = d.Canvas.Code
			n.CanvasName = d.Canvas.Name
		}
		if d.Actor != nil {
			n.ActorName = d.Actor.DisplayName
		}
		out = append(out, n)
	}
	// Newest first, then cap. Sorted/truncated here (small per-user list) to match
	// the rest of the store's "avoid the client order surface" convention.
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *supabaseStore) CountUnreadNotifications(_ context.Context, userID uuid.UUID) (int, error) {
	var rows []struct {
		ReadAt *string `json:"read_at"`
	}
	_, err := s.client.From("notifications").
		Select("read_at", "", false).
		Eq("user_id", userID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range rows {
		if r.ReadAt == nil {
			n++
		}
	}
	return n, nil
}

func (s *supabaseStore) MarkNotificationsRead(_ context.Context, userID uuid.UUID) error {
	// Mark the whole inbox read in one statement: only this user's still-unread
	// rows match, so it's idempotent and touches nothing already read.
	return s.exec(s.client.From("notifications").
		Update(map[string]any{"read_at": time.Now().UTC().Format(time.RFC3339)}, "minimal", "").
		Eq("user_id", userID.String()).
		Is("read_at", "null"))
}

// GetCanvasState uses PostgREST embedded selects — one HTTP request for everything.
func (s *supabaseStore) GetCanvasState(_ context.Context, canvasID uuid.UUID) (*Canvas, *CanvasState, []*PendingEdit, error) {
	var rows []dbCanvasWithChildren

	_, err := s.client.From("canvases").
		Select("*,documents(*),pins(*),events(*),notes(*),roadmap_items(*),sheets(*, sheet_rows(*)),charts(*),forms(*),actions(*),agents(*),pending_edits(*)", "", false).
		Eq("id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("GetCanvasState: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil, nil, fmt.Errorf("canvas not found: %s", canvasID)
	}

	row := rows[0]
	canvas := toCanvas(row.dbCanvas)

	state := &CanvasState{
		Version:      canvas.Version,
		Mode:         canvas.Mode,
		EnabledModes: canvas.EnabledModes,
		Documents:    make(map[string]*Document, len(row.Documents)),
		Pins:         make(map[string]*Pin, len(row.Pins)),
		Events:       make(map[string]*Event, len(row.Events)),
		Notes:        make(map[string]*Note, len(row.Notes)),
		RoadmapItems: make(map[string]*RoadmapItem, len(row.RoadmapItems)),
		Sheets:       make(map[string]*Sheet, len(row.Sheets)),
		SheetRows:    make(map[string]*SheetRow),
		Charts:       make(map[string]*Chart, len(row.Charts)),
		Forms:        make(map[string]*Form, len(row.Forms)),
		Actions:      make(map[string]*Action, len(row.Actions)),
		Agents:       make(map[string]*Agent, len(row.Agents)),
	}
	for _, d := range row.Documents {
		doc := toDocument(d)
		state.Documents[doc.ID.String()] = doc
	}
	for _, d := range row.Pins {
		p := toPin(d)
		state.Pins[p.ID.String()] = p
	}
	for _, d := range row.Events {
		e := toEvent(d)
		state.Events[e.ID.String()] = e
	}
	for _, d := range row.Notes {
		n := toNote(d)
		state.Notes[n.ID.String()] = n
	}
	for _, d := range row.RoadmapItems {
		r := toRoadmapItem(d)
		state.RoadmapItems[r.ID.String()] = r
	}
	for _, d := range row.Sheets {
		sh := toSheet(d)
		state.Sheets[sh.ID.String()] = sh
		// Rows arrive nested under their sheet (see dbSheet.SheetRows); flatten
		// them into the canvas-level SheetRows map the frontend expects.
		for _, rd := range d.SheetRows {
			sr := toSheetRow(rd)
			state.SheetRows[sr.ID.String()] = sr
		}
	}
	for _, d := range row.Charts {
		ch := toChart(d)
		state.Charts[ch.ID.String()] = ch
	}
	for _, d := range row.Forms {
		f := toForm(d)
		state.Forms[f.ID.String()] = f
	}
	for _, d := range row.Actions {
		a := toAction(d)
		state.Actions[a.ID.String()] = a
	}
	for _, d := range row.Agents {
		ag := toAgent(d)
		state.Agents[ag.ID.String()] = ag
	}

	edits := make([]*PendingEdit, 0, len(row.PendingEdits))
	for _, d := range row.PendingEdits {
		edits = append(edits, toPendingEdit(d))
	}
	return canvas, state, edits, nil
}

// getCanvasRowState fetches just the canvas row, returning the Canvas plus its
// parsed enabled_modes. Shared by the per-kind read paths, which need the canvas
// bearings (version/mode/enabledModes) without the embedded child tables.
func (s *supabaseStore) getCanvasRowState(canvasID uuid.UUID) (*Canvas, []string, error) {
	var rows []dbCanvas
	_, err := s.client.From("canvases").
		Select("*", "", false).
		Eq("id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, nil, err
	}
	if len(rows) == 0 {
		return nil, nil, fmt.Errorf("canvas not found: %s", canvasID)
	}
	canvas := toCanvas(rows[0])
	return canvas, canvas.EnabledModes, nil
}

// emptyCanvasState builds a CanvasState carrying only the bearings, with every
// kind map allocated empty. Used by the per-kind read paths so a requested kind
// with zero rows is an empty (not nil) map, and an unrequested kind can be
// nil'd out by the caller's projection.
func emptyCanvasState(version int, mode string, enabledModes []string) *CanvasState {
	return &CanvasState{
		Version:      version,
		Mode:         mode,
		EnabledModes: enabledModes,
		Documents:    map[string]*Document{},
		Pins:         map[string]*Pin{},
		Events:       map[string]*Event{},
		Notes:        map[string]*Note{},
		RoadmapItems: map[string]*RoadmapItem{},
		Sheets:       map[string]*Sheet{},
		SheetRows:    map[string]*SheetRow{},
		Charts:       map[string]*Chart{},
		Forms:        map[string]*Form{},
		Actions:      map[string]*Action{},
		Agents:       map[string]*Agent{},
	}
}

// GetCanvasKinds loads only the requested kinds via per-table SELECTs instead of
// the single big embedded GetCanvasState. Kinds not in `kinds` are left as their
// zero (nil) map so projectState/serialization treat them as absent, matching
// the in-memory field projection's wire shape. See the interface doc.
func (s *supabaseStore) GetCanvasKinds(_ context.Context, canvasID uuid.UUID, kinds []string) (*Canvas, *CanvasState, []*PendingEdit, error) {
	canvas, enabledModes, err := s.getCanvasRowState(canvasID)
	if err != nil {
		return nil, nil, nil, err
	}
	state := emptyCanvasState(canvas.Version, canvas.Mode, enabledModes)

	want := make(map[string]bool, len(kinds))
	for _, k := range kinds {
		want[k] = true
	}
	// Null out kinds we won't fetch so absent kinds serialize to null (same as
	// the in-memory projection), keeping the wire contract identical.
	if !want["documents"] {
		state.Documents = nil
	}
	if !want["pins"] {
		state.Pins = nil
	}
	if !want["events"] {
		state.Events = nil
	}
	if !want["notes"] {
		state.Notes = nil
	}
	if !want["roadmapItems"] {
		state.RoadmapItems = nil
	}
	if !want["sheets"] {
		state.Sheets = nil
	}
	if !want["sheetRows"] {
		state.SheetRows = nil
	}
	if !want["charts"] {
		state.Charts = nil
	}
	if !want["forms"] {
		state.Forms = nil
	}
	if !want["actions"] {
		state.Actions = nil
	}
	if !want["agents"] {
		state.Agents = nil
	}

	for _, k := range kinds {
		if err := s.loadKind(canvasID, k, state); err != nil {
			return nil, nil, nil, fmt.Errorf("GetCanvasKinds(%s): %w", k, err)
		}
	}

	edits, err := s.ListPendingEdits(context.Background(), canvasID)
	if err != nil {
		return nil, nil, nil, err
	}
	return canvas, state, edits, nil
}

// loadKind fetches one kind's full rows for a canvas and populates the matching
// map on state. Kept as a switch (not a table registry) because each kind has
// its own db-row type and converter.
func (s *supabaseStore) loadKind(canvasID uuid.UUID, kind string, state *CanvasState) error {
	id := canvasID.String()
	switch kind {
	case "documents":
		var rows []dbDocument
		if _, err := s.client.From("documents").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			doc := toDocument(d)
			state.Documents[doc.ID.String()] = doc
		}
	case "pins":
		var rows []dbPin
		if _, err := s.client.From("pins").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			p := toPin(d)
			state.Pins[p.ID.String()] = p
		}
	case "events":
		var rows []dbEvent
		if _, err := s.client.From("events").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			e := toEvent(d)
			state.Events[e.ID.String()] = e
		}
	case "notes":
		var rows []dbNote
		if _, err := s.client.From("notes").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			n := toNote(d)
			state.Notes[n.ID.String()] = n
		}
	case "roadmapItems":
		var rows []dbRoadmapItem
		if _, err := s.client.From("roadmap_items").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			r := toRoadmapItem(d)
			state.RoadmapItems[r.ID.String()] = r
		}
	case "sheets":
		var rows []dbSheet
		if _, err := s.client.From("sheets").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			sh := toSheet(d)
			state.Sheets[sh.ID.String()] = sh
		}
	case "sheetRows":
		// sheet_rows has no canvas_id (it's FK'd to sheets), so pull the rows nested
		// under this canvas's sheets and flatten them into the canvas-level map —
		// same shape GetCanvasState produces.
		var rows []dbSheet
		if _, err := s.client.From("sheets").Select("id,sheet_rows(*)", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, sh := range rows {
			for _, rd := range sh.SheetRows {
				sr := toSheetRow(rd)
				state.SheetRows[sr.ID.String()] = sr
			}
		}
	case "charts":
		var rows []dbChart
		if _, err := s.client.From("charts").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			ch := toChart(d)
			state.Charts[ch.ID.String()] = ch
		}
	case "forms":
		var rows []dbForm
		if _, err := s.client.From("forms").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			f := toForm(d)
			state.Forms[f.ID.String()] = f
		}
	case "actions":
		var rows []dbAction
		if _, err := s.client.From("actions").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			a := toAction(d)
			state.Actions[a.ID.String()] = a
		}
	case "agents":
		var rows []dbAgent
		if _, err := s.client.From("agents").Select("*", "", false).Eq("canvas_id", id).ExecuteTo(&rows); err != nil {
			return err
		}
		for _, d := range rows {
			ag := toAgent(d)
			state.Agents[ag.ID.String()] = ag
		}
	}
	return nil
}

// GetCanvasSummary loads the exact per-kind counts plus a capped, name-column
// Sample for the default canvas_state_read. Each name-listed kind is one query
// that both counts (count=exact → total in Content-Range) and returns up to
// sampleLimit rows carrying only the name column(s); the count-only kinds
// (actions, sheetRows) issue a HEAD count with no rows. Nothing loads the full
// canvas. See the interface doc + CanvasSummary.
func (s *supabaseStore) GetCanvasSummary(_ context.Context, canvasID uuid.UUID, sampleLimit int) (*Canvas, *CanvasSummary, []*PendingEdit, error) {
	canvas, enabledModes, err := s.getCanvasRowState(canvasID)
	if err != nil {
		return nil, nil, nil, err
	}
	sum := &CanvasSummary{
		Version:      canvas.Version,
		Mode:         canvas.Mode,
		EnabledModes: enabledModes,
		Counts:       map[string]int{},
		Sample:       emptyCanvasState(canvas.Version, canvas.Mode, enabledModes),
	}
	id := canvasID.String()

	// Name-listed kinds: one query each returns the exact count (Content-Range)
	// AND the capped name-column sample. Only the columns the summary renders a
	// name from are selected, so heavy JSON columns (config/columns/data/…) never
	// leave Postgres. Order by id so the sampled page is stable across reads (the
	// API layer alpha-sorts the names for display on top of that).
	{
		var rows []dbDocument
		n, err := s.client.From("documents").Select("id,name,type", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["documents"] = int(n)
		for _, d := range rows {
			doc := toDocument(d)
			sum.Sample.Documents[doc.ID.String()] = doc
		}
	}
	{
		var rows []dbPin
		n, err := s.client.From("pins").Select("id,label", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["pins"] = int(n)
		for _, d := range rows {
			p := toPin(d)
			sum.Sample.Pins[p.ID.String()] = p
		}
	}
	{
		var rows []dbEvent
		n, err := s.client.From("events").Select("id,title", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["events"] = int(n)
		for _, d := range rows {
			e := toEvent(d)
			sum.Sample.Events[e.ID.String()] = e
		}
	}
	{
		var rows []dbNote
		n, err := s.client.From("notes").Select("id,body", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["notes"] = int(n)
		for _, d := range rows {
			nt := toNote(d)
			sum.Sample.Notes[nt.ID.String()] = nt
		}
	}
	{
		var rows []dbRoadmapItem
		n, err := s.client.From("roadmap_items").Select("id,title", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["roadmapItems"] = int(n)
		for _, d := range rows {
			r := toRoadmapItem(d)
			sum.Sample.RoadmapItems[r.ID.String()] = r
		}
	}
	{
		var rows []dbSheet
		n, err := s.client.From("sheets").Select("id,name", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["sheets"] = int(n)
		for _, d := range rows {
			sh := toSheet(d)
			sum.Sample.Sheets[sh.ID.String()] = sh
		}
	}
	{
		var rows []dbChart
		n, err := s.client.From("charts").Select("id,name", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["charts"] = int(n)
		for _, d := range rows {
			ch := toChart(d)
			sum.Sample.Charts[ch.ID.String()] = ch
		}
	}
	{
		var rows []dbForm
		n, err := s.client.From("forms").Select("id,name", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["forms"] = int(n)
		for _, d := range rows {
			f := toForm(d)
			sum.Sample.Forms[f.ID.String()] = f
		}
	}
	{
		var rows []dbAgent
		n, err := s.client.From("agents").Select("id,name", "exact", false).Eq("canvas_id", id).Order("id", nil).Limit(sampleLimit, "").ExecuteTo(&rows)
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["agents"] = int(n)
		for _, d := range rows {
			ag := toAgent(d)
			sum.Sample.Agents[ag.ID.String()] = ag
		}
	}

	// Count-only kinds: actions are deliberately never name-listed, and sheet_rows
	// has no name to list — a HEAD count (head=true → no rows transferred) is all
	// the summary needs.
	{
		_, n, err := s.client.From("actions").Select("id", "exact", true).Eq("canvas_id", id).Execute()
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["actions"] = int(n)
	}
	{
		// sheet_rows is FK'd to sheets (no canvas_id), so scope the count through an
		// inner join on the parent sheet's canvas_id.
		_, n, err := s.client.From("sheet_rows").Select("id,sheets!inner(canvas_id)", "exact", true).Eq("sheets.canvas_id", id).Execute()
		if err != nil {
			return nil, nil, nil, err
		}
		sum.Counts["sheetRows"] = int(n)
	}

	edits, err := s.ListPendingEdits(context.Background(), canvasID)
	if err != nil {
		return nil, nil, nil, err
	}
	return canvas, sum, edits, nil
}

func (s *supabaseStore) SetMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"mode": mode}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// EnableMode adds a mode to the canvas's enabled_modes set (the user turning on
// an empty tab). Idempotent: if the mode is already enabled it's a no-op and the
// version is left untouched so we don't churn a needless broadcast.
func (s *supabaseStore) EnableMode(ctx context.Context, canvasID uuid.UUID, mode string) (int, error) {
	var rows []struct {
		EnabledModes json.RawMessage `json:"enabled_modes"`
		Version      int             `json:"version"`
	}
	_, err := s.client.From("canvases").
		Select("enabled_modes,version", "", false).
		Eq("id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("canvas not found: %s", canvasID)
	}

	modes := parseEnabledModes(rows[0].EnabledModes)
	for _, m := range modes {
		if m == mode {
			return rows[0].Version, nil // already enabled — no write, no bump
		}
	}
	modes = append(modes, mode)

	err = s.exec(s.client.From("canvases").
		Update(map[string]any{"enabled_modes": modes}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) SetMapID(ctx context.Context, canvasID uuid.UUID, mapID string) (int, error) {
	err := s.exec(s.client.From("canvases").
		Update(map[string]string{"map_id": mapID}, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ApplyTemplate(ctx context.Context, canvasID uuid.UUID, mode string, mapID *string) (int, error) {
	update := map[string]any{"mode": mode}
	if mapID != nil {
		update["map_id"] = *mapID
	}
	err := s.exec(s.client.From("canvases").
		Update(update, "minimal", "").
		Eq("id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// LeaveWelcomeIfNeeded transitions a canvas out of `welcome` mode after an entity
// write (pin/event/note). Idempotent — no-op if the canvas is already in a non-welcome
// mode. fallbackMode is the mode to transition to (typically map/itinerary/docs based
// on which entity was written).
func (s *supabaseStore) LeaveWelcomeIfNeeded(ctx context.Context, canvasID uuid.UUID, fallbackMode string) error {
	c, err := s.GetCanvasByID(ctx, canvasID)
	if err != nil {
		return err
	}
	if c.Mode != "welcome" {
		return nil
	}
	update := map[string]any{"mode": fallbackMode}
	// If transitioning to map and no preset yet chosen, drop a sensible default
	if fallbackMode == "map" && c.MapID == nil {
		update["map_id"] = "us"
	}
	err = s.exec(s.client.From("canvases").
		Update(update, "minimal", "").
		Eq("id", canvasID.String()).
		Eq("mode", "welcome"))
	return err
}

// ── Pins ──────────────────────────────────────────────────────────────────────

// ── Documents (migration 0024) ────────────────────────────────────────────────

func (s *supabaseStore) CreateDocument(ctx context.Context, canvasID uuid.UUID, d *Document) (int, error) {
	cfg := d.Config
	if cfg == nil {
		cfg = map[string]any{}
	}
	cfgJSON, err := json.Marshal(cfg)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	d.UpdatedAt = now
	row := map[string]any{
		"id":         d.ID.String(),
		"canvas_id":  canvasID.String(),
		"type":       d.Type,
		"name":       d.Name,
		"parent_id":  uuidPtrStr(d.ParentID),
		"sort_order": d.SortOrder,
		"config":     json.RawMessage(cfgJSON),
		"created_by": d.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("documents").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateDocument(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch DocumentPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil {
		m["name"] = *patch.Name
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	if patch.Config != nil {
		cfgJSON, err := json.Marshal(patch.Config)
		if err != nil {
			return 0, err
		}
		m["config"] = json.RawMessage(cfgJSON)
	}
	if patch.SetParent {
		m["parent_id"] = uuidPtrStr(patch.ParentID) // nil → NULL (move to root)
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("documents").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteDocument(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("documents").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ReorderDocuments(ctx context.Context, canvasID uuid.UUID, updates []DocumentReorder) (int, error) {
	for _, u := range updates {
		err := s.exec(s.client.From("documents").
			Update(map[string]any{
				"sort_order": u.SortOrder,
				"parent_id":  uuidPtrStr(u.ParentID), // always interpreted; nil → root
			}, "minimal", "").
			Eq("id", u.ID.String()).
			Eq("canvas_id", canvasID.String()))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ListDocuments(_ context.Context, canvasID uuid.UUID) ([]*Document, error) {
	var rows []dbDocument
	_, err := s.client.From("documents").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]*Document, 0, len(rows))
	for _, d := range rows {
		out = append(out, toDocument(d))
	}
	return out, nil
}

func (s *supabaseStore) GetDocument(_ context.Context, canvasID, id uuid.UUID) (*Document, error) {
	var rows []dbDocument
	_, err := s.client.From("documents").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("document %s not found in canvas %s", id, canvasID)
	}
	return toDocument(rows[0]), nil
}

// pinRow shapes a Pin into its DB row. Shared by the single- and bulk-insert
// paths so both stay in lockstep on column mapping.
func pinRow(canvasID uuid.UUID, pin *Pin, now time.Time) map[string]any {
	return map[string]any{
		"id": pin.ID.String(), "canvas_id": canvasID.String(),
		"document_id": uuidPtrStr(pin.DocumentID),
		"pin_type":    pin.PinType, "lat": pin.Lat, "lng": pin.Lng,
		"label": pin.Label, "body": pin.Body, "color": pin.Color,
		"created_by": pin.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
}

func (s *supabaseStore) CreatePin(ctx context.Context, canvasID uuid.UUID, pin *Pin) (int, error) {
	now := time.Now().UTC()
	pin.UpdatedAt = now
	err := s.exec(s.client.From("pins").Insert(pinRow(canvasID, pin, now), false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "map")
	return s.bumpVersion(ctx, canvasID)
}

// CreatePins inserts many pins in a SINGLE round trip — one bulk INSERT, one
// welcome-transition check, one version bump — instead of N of each. The caller
// (the batch handler) broadcasts once after this returns, so an N-pin itinerary
// costs one full-canvas reload instead of N. Returns the new canvas version.
func (s *supabaseStore) CreatePins(ctx context.Context, canvasID uuid.UUID, pins []*Pin) (int, error) {
	if len(pins) == 0 {
		return 0, nil
	}
	now := time.Now().UTC()
	rows := make([]map[string]any, 0, len(pins))
	for _, pin := range pins {
		pin.UpdatedAt = now
		rows = append(rows, pinRow(canvasID, pin, now))
	}
	if err := s.exec(s.client.From("pins").Insert(rows, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "map")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdatePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch PinPatch) (int, error) {
	m := map[string]any{}
	if patch.PinType != nil {
		m["pin_type"] = *patch.PinType
	}
	if patch.Lat != nil {
		m["lat"] = *patch.Lat
	}
	if patch.Lng != nil {
		m["lng"] = *patch.Lng
	}
	if patch.Label != nil {
		m["label"] = *patch.Label
	}
	if patch.Body != nil {
		m["body"] = *patch.Body
	}
	if patch.Color != nil {
		m["color"] = *patch.Color
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("pins").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeletePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("pins").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Events ────────────────────────────────────────────────────────────────────

// eventRow shapes an Event into its DB row, canonicalizing the pin list.
// Shared by the single- and bulk-insert paths. Every key is always present
// (nil when unset) so that a batch INSERT's rows all share identical key
// sets — PostgREST's bulk insert (PGRST102) rejects a JSON array whose
// objects don't all have matching keys.
func eventRow(canvasID uuid.UUID, ev *Event, now time.Time) map[string]any {
	// Canonicalize the pin list: prefer PinIDs, fall back to a single PinID.
	if len(ev.PinIDs) == 0 && ev.PinID != nil {
		ev.PinIDs = []uuid.UUID{*ev.PinID}
	}
	var endTime any
	if ev.End != nil {
		endTime = ev.End.Format(time.RFC3339)
	}
	var timezone any
	if ev.Timezone != nil {
		timezone = *ev.Timezone
	}
	var pinID any
	if ev.PinID != nil {
		pinID = ev.PinID.String()
	}
	var fromPinID any
	if ev.FromPinID != nil {
		fromPinID = ev.FromPinID.String()
	}
	var toPinID any
	if ev.ToPinID != nil {
		toPinID = ev.ToPinID.String()
	}
	var travelMode any
	if ev.TravelMode != nil {
		travelMode = *ev.TravelMode
	}
	var dayTag any
	if ev.DayTag != nil {
		dayTag = *ev.DayTag
	}
	var cost any
	if ev.Cost != nil {
		cost = *ev.Cost
	}
	return map[string]any{
		"id": ev.ID.String(), "canvas_id": canvasID.String(),
		"document_id": uuidPtrStr(ev.DocumentID),
		"title":       ev.Title, "start_time": ev.Start.Format(time.RFC3339),
		"end_time":    endTime,
		"timezone":    timezone,
		"pin_ids":     uuidStrings(ev.PinIDs),
		"pin_id":      pinID,
		"from_pin_id": fromPinID,
		"to_pin_id":   toPinID,
		"travel_mode": travelMode,
		"day_tag":     dayTag,
		"cost":        cost,
		"created_by":  ev.CreatedBy,
		"updated_at":  now.Format(time.RFC3339),
	}
}

func (s *supabaseStore) CreateEvent(ctx context.Context, canvasID uuid.UUID, ev *Event) (int, error) {
	now := time.Now().UTC()
	ev.UpdatedAt = now
	err := s.exec(s.client.From("events").Insert(eventRow(canvasID, ev, now), false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "itinerary")
	return s.bumpVersion(ctx, canvasID)
}

// CreateEvents inserts many itinerary entries in a SINGLE round trip — one bulk
// INSERT, one welcome-transition check, one version bump. The batch handler
// broadcasts once after this returns. Returns the new canvas version.
func (s *supabaseStore) CreateEvents(ctx context.Context, canvasID uuid.UUID, events []*Event) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}
	now := time.Now().UTC()
	rows := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		ev.UpdatedAt = now
		rows = append(rows, eventRow(canvasID, ev, now))
	}
	if err := s.exec(s.client.From("events").Insert(rows, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "itinerary")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch EventPatch) (int, error) {
	m := map[string]any{}
	if patch.Title != nil {
		m["title"] = *patch.Title
	}
	if patch.Start != nil {
		m["start_time"] = patch.Start.Format(time.RFC3339)
	}
	if patch.End != nil {
		m["end_time"] = patch.End.Format(time.RFC3339)
	}
	if patch.Timezone != nil {
		m["timezone"] = *patch.Timezone
	}
	if patch.PinIDs != nil {
		m["pin_ids"] = uuidStrings(*patch.PinIDs)
	}
	if patch.PinID != nil {
		m["pin_id"] = patch.PinID.String()
	}
	if patch.FromPinID != nil {
		m["from_pin_id"] = patch.FromPinID.String()
	}
	if patch.ToPinID != nil {
		m["to_pin_id"] = patch.ToPinID.String()
	}
	if patch.TravelMode != nil {
		m["travel_mode"] = *patch.TravelMode
	}
	if patch.DayTag != nil {
		m["day_tag"] = *patch.DayTag
	}
	if patch.Cost != nil {
		m["cost"] = *patch.Cost
	}
	// Clears win over sets and write a SQL NULL (nil map value → JSON null).
	if patch.ClearEnd {
		m["end_time"] = nil
	}
	if patch.ClearCost {
		m["cost"] = nil
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("events").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("events").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

// nextNoteSortOrder appends a new note after the last one in its document, so
// creating a note never displaces the notes already on the page. Scoped by
// canvas_id too because document_id is nullable (pre-0024 rows): those orphans
// order among themselves per canvas rather than sharing one global NULL bucket.
func (s *supabaseStore) nextNoteSortOrder(canvasID uuid.UUID, documentID *uuid.UUID) (int, error) {
	q := s.client.From("notes").Select("sort_order", "", false).Eq("canvas_id", canvasID.String())
	if documentID != nil {
		q = q.Eq("document_id", documentID.String())
	} else {
		q = q.Is("document_id", "null")
	}
	var rows []struct {
		SortOrder int `json:"sort_order"`
	}
	if _, err := q.ExecuteTo(&rows); err != nil {
		return 0, err
	}
	max := -1
	for _, r := range rows {
		if r.SortOrder > max {
			max = r.SortOrder
		}
	}
	return max + 1, nil
}

func (s *supabaseStore) CreateNote(ctx context.Context, canvasID uuid.UUID, n *Note) (int, error) {
	now := time.Now().UTC()
	n.UpdatedAt = now
	refs := n.ImageRefs
	if refs == nil {
		refs = []string{}
	}
	// Callers don't pick a position: every creation path (web, REST, MCP) appends.
	sortOrder, err := s.nextNoteSortOrder(canvasID, n.DocumentID)
	if err != nil {
		return 0, err
	}
	n.SortOrder = sortOrder
	row := map[string]any{
		"id": n.ID.String(), "canvas_id": canvasID.String(),
		"document_id": uuidPtrStr(n.DocumentID),
		"body":        n.Body, "image_refs": refs,
		"parent_kind": n.ParentKind, "created_by": n.CreatedBy,
		"sort_order":  n.SortOrder,
		"updated_at":  now.Format(time.RFC3339),
	}
	if n.ParentID != nil {
		row["parent_id"] = n.ParentID.String()
	}
	if err := s.exec(s.client.From("notes").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "docs")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch NotePatch) (int, error) {
	m := map[string]any{}
	if patch.Body != nil {
		m["body"] = *patch.Body
	}
	if patch.ImageRefs != nil {
		m["image_refs"] = patch.ImageRefs
	}
	if patch.ParentKind != nil {
		m["parent_kind"] = *patch.ParentKind
	}
	if patch.ParentID != nil {
		m["parent_id"] = patch.ParentID.String()
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("notes").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("notes").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Roadmap items ─────────────────────────────────────────────────────────────

func (s *supabaseStore) CreateRoadmapItem(ctx context.Context, canvasID uuid.UUID, r *RoadmapItem) (int, error) {
	now := time.Now().UTC()
	r.UpdatedAt = now
	row := map[string]any{
		"id": r.ID.String(), "canvas_id": canvasID.String(),
		"document_id": uuidPtrStr(r.DocumentID),
		"title":       r.Title, "body": r.Body,
		"status": r.Status, "sort_order": r.SortOrder,
		"created_by": r.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if r.ParentID != nil {
		row["parent_id"] = r.ParentID.String()
	}
	if r.Stage != "" {
		row["stage"] = r.Stage
	}
	if r.Assignee != "" {
		row["assignee"] = r.Assignee
	}
	err := s.exec(s.client.From("roadmap_items").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "roadmap")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch RoadmapItemPatch) (int, error) {
	m := map[string]any{}
	if patch.Title != nil {
		m["title"] = *patch.Title
	}
	if patch.Body != nil {
		m["body"] = *patch.Body
	}
	if patch.Status != nil {
		m["status"] = *patch.Status
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	if patch.ParentID != nil {
		m["parent_id"] = patch.ParentID.String()
	}
	// Stage: "" clears the phase (store NULL), a label sets it.
	if patch.Stage != nil {
		if *patch.Stage == "" {
			m["stage"] = nil
		} else {
			m["stage"] = *patch.Stage
		}
	}
	// Assignee: "agent" marks it an agent task; "" (or "human") clears the mark
	// back to a human goal (store NULL).
	if patch.Assignee != nil {
		if *patch.Assignee == "agent" {
			m["assignee"] = "agent"
		} else {
			m["assignee"] = nil
		}
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("roadmap_items").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteRoadmapItem(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("roadmap_items").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ListRoadmapItems returns a canvas's roadmap items ordered by sort_order,
// optionally filtered by assignee ("agent" = the agent-task queue; "" = all).
func (s *supabaseStore) ListRoadmapItems(_ context.Context, canvasID uuid.UUID, assignee string) ([]*RoadmapItem, error) {
	var rows []dbRoadmapItem
	q := s.client.From("roadmap_items").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String())
	if assignee != "" {
		q = q.Eq("assignee", assignee)
	}
	if _, err := q.Order("sort_order", nil).ExecuteTo(&rows); err != nil {
		return nil, err
	}
	items := make([]*RoadmapItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, toRoadmapItem(r))
	}
	return items, nil
}

// ReorderRoadmapItems applies a batch of (parent_id, sort_order) updates and
// bumps version once. The frontend builds the batch from a single drag-and-drop
// gesture, so we avoid N broadcasts. Not transactional — a partial failure
// leaves the tree in a valid (but unintended) state; the next state read
// reconciles.
func (s *supabaseStore) ReorderRoadmapItems(ctx context.Context, canvasID uuid.UUID, updates []RoadmapReorder) (int, error) {
	for _, u := range updates {
		m := map[string]any{"sort_order": u.SortOrder}
		if u.ParentID != nil {
			m["parent_id"] = u.ParentID.String()
		} else {
			m["parent_id"] = nil
		}
		err := s.exec(s.client.From("roadmap_items").
			Update(m, "minimal", "").
			Eq("id", u.ID.String()).
			Eq("canvas_id", canvasID.String()))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Agents (v1 identity / provenance) ─────────────────────────────────────────

func (s *supabaseStore) RegisterAgent(ctx context.Context, canvasID uuid.UUID, a *Agent) (int, error) {
	now := time.Now().UTC()
	a.LastSeenAt = now
	a.Status = "online"
	row := map[string]any{
		"id": a.ID.String(), "canvas_id": canvasID.String(),
		"name": a.Name, "role": a.Role, "status": "online",
		"last_seen_at": now.Format(time.RFC3339),
	}
	if a.Model != nil {
		row["model"] = *a.Model
	}
	if err := s.exec(s.client.From("agents").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Actions (v1 execution primitive) ──────────────────────────────────────────

func (s *supabaseStore) CreateAction(ctx context.Context, canvasID uuid.UUID, a *Action) (int, error) {
	now := time.Now().UTC()
	a.CreatedAt, a.UpdatedAt = now, now
	if len(a.Payload) == 0 {
		a.Payload = json.RawMessage("{}")
	}
	linkedJSON, err := json.Marshal(uuidStrings(a.LinkedPinIDs))
	if err != nil {
		return 0, err
	}
	row := map[string]any{
		"id": a.ID.String(), "canvas_id": canvasID.String(),
		"type": a.Type, "state": a.State,
		"payload":        json.RawMessage(a.Payload),
		"proposed_by":    a.ProposedBy,
		"linked_pin_ids": json.RawMessage(linkedJSON),
		"updated_at":     now.Format(time.RFC3339),
	}
	if a.ApprovedBy != nil {
		row["approved_by"] = *a.ApprovedBy
	}
	if err := s.exec(s.client.From("actions").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) GetAction(_ context.Context, canvasID, id uuid.UUID) (*Action, error) {
	var rows []dbAction
	_, err := s.client.From("actions").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("action %s not found in canvas %s", id, canvasID)
	}
	return toAction(rows[0]), nil
}

func (s *supabaseStore) ListActions(_ context.Context, canvasID uuid.UUID, stateFilter, typeFilter, assigneeFilter string) ([]*Action, error) {
	var rows []dbAction
	q := s.client.From("actions").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String())
	if stateFilter != "" {
		q = q.Eq("state", stateFilter)
	}
	if typeFilter != "" {
		q = q.Eq("type", typeFilter)
	}
	switch assigneeFilter {
	case "":
	case "agent":
		// Tasks created before the assignee field existed are agent tasks.
		q = q.Or("payload->>assignee.eq.agent,payload->>assignee.is.null", "")
	default:
		q = q.Eq("payload->>assignee", assigneeFilter)
	}
	if _, err := q.Order("created_at", nil).ExecuteTo(&rows); err != nil {
		return nil, err
	}
	out := make([]*Action, 0, len(rows))
	for _, d := range rows {
		out = append(out, toAction(d))
	}
	return out, nil
}

// UpdateActionState applies a single transition. The caller (handler) is
// responsible for validating the transition is legal; this just writes the
// fields the target state carries.
func (s *supabaseStore) UpdateActionState(ctx context.Context, canvasID, id uuid.UUID, patch ActionStatePatch) (int, error) {
	m := map[string]any{"state": patch.State}
	if patch.Result != nil {
		m["result"] = *patch.Result
	}
	if patch.Error != nil {
		m["error"] = *patch.Error
	}
	if patch.ApprovedBy != nil {
		m["approved_by"] = *patch.ApprovedBy
	}
	if len(patch.Payload) > 0 {
		m["payload"] = json.RawMessage(patch.Payload)
	}
	err := s.exec(s.client.From("actions").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// UpdateActionPayload replaces an action's payload without touching its state —
// the edit path for task content (title / body / links / assignee).
func (s *supabaseStore) UpdateActionPayload(ctx context.Context, canvasID, id uuid.UUID, payload json.RawMessage) (int, error) {
	err := s.exec(s.client.From("actions").
		Update(map[string]any{"payload": payload}, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// DeleteAction removes an action row (e.g. deleting a task from the queue).
func (s *supabaseStore) DeleteAction(ctx context.Context, canvasID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("actions").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// GetLinkedEntities resolves a task's payload.linkedIds against roadmap items
// and notes (the two entity kinds tasks link to). Unknown ids are skipped, not
// errors — a linked item may have been deleted since the task was written.
func (s *supabaseStore) GetLinkedEntities(_ context.Context, canvasID uuid.UUID, ids []uuid.UUID) ([]TaskLink, error) {
	if len(ids) == 0 {
		return []TaskLink{}, nil
	}
	idStrs := uuidStrings(ids)

	var items []dbRoadmapItem
	if _, err := s.client.From("roadmap_items").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String()).
		In("id", idStrs).
		ExecuteTo(&items); err != nil {
		return nil, err
	}
	var notes []dbNote
	if _, err := s.client.From("notes").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String()).
		In("id", idStrs).
		ExecuteTo(&notes); err != nil {
		return nil, err
	}

	links := make([]TaskLink, 0, len(items)+len(notes))
	for _, it := range items {
		id, err := uuid.Parse(it.ID)
		if err != nil {
			continue
		}
		links = append(links, TaskLink{ID: id, Kind: "roadmap", Title: it.Title, Body: it.Body, Status: it.Status})
	}
	for _, n := range notes {
		id, err := uuid.Parse(n.ID)
		if err != nil {
			continue
		}
		links = append(links, TaskLink{ID: id, Kind: "note", Body: n.Body})
	}
	return links, nil
}

// ── Sheets ────────────────────────────────────────────────────────────────────

// sheetBelongsToCanvas verifies a sheet's canvas_id before allowing column/row
// mutations against it. PostgREST won't filter through embedded selects, so we
// must check explicitly to prevent cross-canvas writes.
func (s *supabaseStore) sheetBelongsToCanvas(canvasID, sheetID uuid.UUID) error {
	var rows []dbSheet
	_, err := s.client.From("sheets").
		Select("id", "", false).
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("sheet %s not found in canvas %s", sheetID, canvasID)
	}
	return nil
}

func (s *supabaseStore) getSheet(canvasID, sheetID uuid.UUID) (*Sheet, error) {
	var rows []dbSheet
	_, err := s.client.From("sheets").
		Select("*", "", false).
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("sheet %s not found in canvas %s", sheetID, canvasID)
	}
	return toSheet(rows[0]), nil
}

func (s *supabaseStore) CreateSheet(ctx context.Context, canvasID uuid.UUID, sh *Sheet) (int, error) {
	cols := sh.Columns
	if cols == nil {
		cols = []SheetColumn{}
	}
	colsJSON, err := json.Marshal(cols)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	sh.UpdatedAt = now
	// A sheet is 1:1 with a 'sheet' document (migration 0024) — it's a tab. Mint
	// the backing document if the caller didn't supply one, so every sheet shows
	// up in the tab strip / explorer regardless of which entry point created it.
	if sh.DocumentID == nil {
		doc := &Document{ID: uuid.New(), Kind: "document", Type: "sheet",
			Name: sh.Name, SortOrder: sh.SortOrder, CreatedBy: sh.CreatedBy}
		if _, err := s.CreateDocument(ctx, canvasID, doc); err != nil {
			return 0, err
		}
		sh.DocumentID = &doc.ID
	}
	row := map[string]any{
		"id":          sh.ID.String(),
		"canvas_id":   canvasID.String(),
		"document_id": uuidPtrStr(sh.DocumentID),
		"name":        sh.Name,
		"columns":     json.RawMessage(colsJSON),
		"sort_order":  sh.SortOrder,
		"created_by":  sh.CreatedBy,
		"updated_at":  now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("sheets").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "sheets")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil {
		m["name"] = *patch.Name
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("sheets").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteSheet(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	// The document is the canonical parent (migration 0024): if this sheet backs a
	// tab, delete the document so the tab disappears too — the FK cascade takes the
	// sheet (and its rows) with it. Fall back to a direct delete for any pre-0024
	// sheet that has no document.
	if sh, err := s.getSheet(canvasID, id); err == nil && sh.DocumentID != nil {
		return s.DeleteDocument(ctx, canvasID, *sh.DocumentID)
	}
	err := s.exec(s.client.From("sheets").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) AddSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, col SheetColumn) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	if col.ID == "" {
		col.ID = uuid.New().String()
	}
	sh.Columns = append(sh.Columns, col)
	return s.writeSheetColumns(ctx, canvasID, sheetID, sh.Columns)
}

func (s *supabaseStore) UpdateSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string, patch SheetColumnPatch) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	found := false
	for i := range sh.Columns {
		if sh.Columns[i].ID == columnID {
			if patch.Name != nil {
				sh.Columns[i].Name = *patch.Name
			}
			if patch.Type != nil {
				sh.Columns[i].Type = *patch.Type
			}
			if patch.SortOrder != nil {
				sh.Columns[i].SortOrder = *patch.SortOrder
			}
			found = true
			break
		}
	}
	if !found {
		return 0, fmt.Errorf("column %s not found in sheet %s", columnID, sheetID)
	}
	return s.writeSheetColumns(ctx, canvasID, sheetID, sh.Columns)
}

// DeleteSheetColumn removes the column from the sheet's columns JSONB AND strips
// the same key from every row's data JSONB. Two writes per affected row.
func (s *supabaseStore) DeleteSheetColumn(ctx context.Context, canvasID, sheetID uuid.UUID, columnID string) (int, error) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return 0, err
	}
	filtered := make([]SheetColumn, 0, len(sh.Columns))
	for _, c := range sh.Columns {
		if c.ID != columnID {
			filtered = append(filtered, c)
		}
	}
	if _, err := s.writeSheetColumns(ctx, canvasID, sheetID, filtered); err != nil {
		return 0, err
	}
	// Strip the column from each row's JSONB. Cheap-and-clear approach: fetch
	// all rows for this sheet, mutate, write back. For sheets with <10k rows
	// this is fine; if a sheet outgrows that we'd switch to a Postgres function.
	var rows []dbSheetRow
	_, err = s.client.From("sheet_rows").
		Select("*", "", false).
		Eq("sheet_id", sheetID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		var data map[string]any
		_ = json.Unmarshal(r.Data, &data)
		if _, ok := data[columnID]; !ok {
			continue
		}
		delete(data, columnID)
		newJSON, _ := json.Marshal(data)
		err := s.exec(s.client.From("sheet_rows").
			Update(map[string]any{"data": json.RawMessage(newJSON)}, "minimal", "").
			Eq("id", r.ID))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) writeSheetColumns(ctx context.Context, canvasID, sheetID uuid.UUID, cols []SheetColumn) (int, error) {
	colsJSON, err := json.Marshal(cols)
	if err != nil {
		return 0, err
	}
	err = s.exec(s.client.From("sheets").
		Update(map[string]any{"columns": json.RawMessage(colsJSON)}, "minimal", "").
		Eq("id", sheetID.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// resolveRowData remaps human-friendly column-name keys in row data to the
// canonical column.id keys storage uses (the JSONB is keyed by id so renames
// stay free — see migration 0007). Keys already matching a column id pass
// through; keys matching a column name (case-insensitive) are rewritten to that
// column's id; anything unrecognized is left untouched. This lets agents write
// rows keyed by column name without first looking up the column uuids.
func resolveRowData(cols []SheetColumn, data map[string]any) map[string]any {
	if len(data) == 0 || len(cols) == 0 {
		return data
	}
	ids := make(map[string]bool, len(cols))
	byName := make(map[string]string, len(cols))
	for _, c := range cols {
		ids[c.ID] = true
		byName[strings.ToLower(strings.TrimSpace(c.Name))] = c.ID
	}
	out := make(map[string]any, len(data))
	for k, v := range data {
		if ids[k] {
			out[k] = v
		} else if id, ok := byName[strings.ToLower(strings.TrimSpace(k))]; ok {
			out[id] = v
		} else {
			out[k] = v
		}
	}
	return out
}

func (s *supabaseStore) CreateSheetRow(ctx context.Context, canvasID uuid.UUID, r *SheetRow) (int, error) {
	// getSheet both scope-checks the sheet against the canvas and gives us the
	// column schema needed to resolve name-keyed cell data.
	sh, err := s.getSheet(canvasID, r.SheetID)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	r.UpdatedAt = now
	data := resolveRowData(sh.Columns, r.Data)
	if data == nil {
		data = map[string]any{}
	}
	r.Data = data
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	row := map[string]any{
		"id":         r.ID.String(),
		"sheet_id":   r.SheetID.String(),
		"data":       json.RawMessage(dataJSON),
		"sort_order": r.SortOrder,
		"created_by": r.CreatedBy,
		"updated_at": now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("sheet_rows").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// UpdateSheetRow merges patch.Data into the existing row data (rather than
// replacing wholesale) so partial cell updates don't clobber other cells.
func (s *supabaseStore) UpdateSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch SheetRowPatch) (int, error) {
	if patch.Data == nil && patch.SortOrder == nil {
		return 0, nil
	}
	// Fetch existing row to scope by canvas and to merge data.
	var rows []dbSheetRow
	_, err := s.client.From("sheet_rows").
		Select("*,sheets!inner(canvas_id)", "", false).
		Eq("id", id.String()).
		Eq("sheets.canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("sheet row %s not found in canvas %s", id, canvasID)
	}
	m := map[string]any{}
	if patch.Data != nil {
		// Resolve name-keyed cells to column ids before merging (best-effort:
		// if the sheet lookup fails we merge the keys as given).
		if sheetID, perr := uuid.Parse(rows[0].SheetID); perr == nil {
			if sh, serr := s.getSheet(canvasID, sheetID); serr == nil {
				patch.Data = resolveRowData(sh.Columns, patch.Data)
			}
		}
		var existing map[string]any
		_ = json.Unmarshal(rows[0].Data, &existing)
		if existing == nil {
			existing = map[string]any{}
		}
		for k, v := range patch.Data {
			if v == nil {
				delete(existing, k)
			} else {
				existing[k] = v
			}
		}
		merged, _ := json.Marshal(existing)
		m["data"] = json.RawMessage(merged)
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	err = s.exec(s.client.From("sheet_rows").
		Update(m, "minimal", "").
		Eq("id", id.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteSheetRow(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	// Scope-check: use embedded join filter to ensure the row's sheet belongs to canvas.
	var rows []dbSheetRow
	_, err := s.client.From("sheet_rows").
		Select("id,sheets!inner(canvas_id)", "", false).
		Eq("id", id.String()).
		Eq("sheets.canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("sheet row %s not found in canvas %s", id, canvasID)
	}
	err = s.exec(s.client.From("sheet_rows").
		Delete("minimal", "").
		Eq("id", id.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) ReorderSheetRows(ctx context.Context, canvasID, sheetID uuid.UUID, updates []SheetRowReorder) (int, error) {
	if err := s.sheetBelongsToCanvas(canvasID, sheetID); err != nil {
		return 0, err
	}
	for _, u := range updates {
		err := s.exec(s.client.From("sheet_rows").
			Update(map[string]any{"sort_order": u.SortOrder}, "minimal", "").
			Eq("id", u.ID.String()).
			Eq("sheet_id", sheetID.String()))
		if err != nil {
			return 0, err
		}
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Charts ────────────────────────────────────────────────────────────────────

func (s *supabaseStore) getChart(canvasID, id uuid.UUID) (*Chart, error) {
	var rows []dbChart
	_, err := s.client.From("charts").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("chart %s not found in canvas %s", id, canvasID)
	}
	return toChart(rows[0]), nil
}

// resolveChartCols maps human-readable column NAMES to SheetColumn ids so agents
// can pass either. An exact id match wins; otherwise a case-insensitive name
// match; otherwise the ref is left as-is. Empty x is passed through (used by
// UpdateChart when only y columns change).
func (s *supabaseStore) resolveChartCols(canvasID, sheetID uuid.UUID, x string, ys []string) (string, []string) {
	sh, err := s.getSheet(canvasID, sheetID)
	if err != nil {
		return x, ys
	}
	resolve := func(ref string) string {
		ref = strings.TrimSpace(ref)
		for _, c := range sh.Columns {
			if c.ID == ref {
				return ref
			}
		}
		for _, c := range sh.Columns {
			if strings.EqualFold(strings.TrimSpace(c.Name), ref) {
				return c.ID
			}
		}
		return ref
	}
	rx := x
	if x != "" {
		rx = resolve(x)
	}
	rys := make([]string, 0, len(ys))
	for _, y := range ys {
		if strings.TrimSpace(y) != "" {
			rys = append(rys, resolve(y))
		}
	}
	return rx, rys
}

func (s *supabaseStore) CreateChart(ctx context.Context, canvasID uuid.UUID, ch *Chart) (int, error) {
	if err := s.sheetBelongsToCanvas(canvasID, ch.SheetID); err != nil {
		return 0, err
	}
	ch.XColumn, ch.YColumns = s.resolveChartCols(canvasID, ch.SheetID, ch.XColumn, ch.YColumns)
	if ch.YColumns == nil {
		ch.YColumns = []string{}
	}
	ysJSON, err := json.Marshal(ch.YColumns)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	ch.UpdatedAt = now
	// A chart is 1:1 with a 'chart' document (its tab) — mint one if absent.
	if ch.DocumentID == nil {
		doc := &Document{ID: uuid.New(), Kind: "document", Type: "chart",
			Name: ch.Name, SortOrder: ch.SortOrder, CreatedBy: ch.CreatedBy}
		if _, err := s.CreateDocument(ctx, canvasID, doc); err != nil {
			return 0, err
		}
		ch.DocumentID = &doc.ID
	}
	row := map[string]any{
		"id":          ch.ID.String(),
		"canvas_id":   canvasID.String(),
		"document_id": uuidPtrStr(ch.DocumentID),
		"sheet_id":    ch.SheetID.String(),
		"name":        ch.Name,
		"chart_type":  ch.ChartType,
		"x_column":    ch.XColumn,
		"y_columns":   json.RawMessage(ysJSON),
		"sort_order":  ch.SortOrder,
		"created_by":  ch.CreatedBy,
		"updated_at":  now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("charts").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	_ = s.LeaveWelcomeIfNeeded(ctx, canvasID, "charts")
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch ChartPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil {
		m["name"] = *patch.Name
	}
	if patch.ChartType != nil {
		m["chart_type"] = *patch.ChartType
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}

	// Column refs are resolved against the chart's (possibly new) sheet.
	if patch.XColumn != nil || patch.YColumns != nil || patch.SheetID != nil {
		var sheetID uuid.UUID
		if patch.SheetID != nil {
			sheetID = *patch.SheetID
			if err := s.sheetBelongsToCanvas(canvasID, sheetID); err != nil {
				return 0, err
			}
			m["sheet_id"] = sheetID.String()
		} else {
			cur, err := s.getChart(canvasID, id)
			if err != nil {
				return 0, err
			}
			sheetID = cur.SheetID
		}
		if patch.XColumn != nil {
			x, _ := s.resolveChartCols(canvasID, sheetID, *patch.XColumn, nil)
			m["x_column"] = x
		}
		if patch.YColumns != nil {
			_, ys := s.resolveChartCols(canvasID, sheetID, "", *patch.YColumns)
			if ys == nil {
				ys = []string{}
			}
			yj, err := json.Marshal(ys)
			if err != nil {
				return 0, err
			}
			m["y_columns"] = json.RawMessage(yj)
		}
	}

	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("charts").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteChart(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	// Canonical delete via the backing 'chart' document (its tab); see DeleteSheet.
	if ch, err := s.getChart(canvasID, id); err == nil && ch.DocumentID != nil {
		return s.DeleteDocument(ctx, canvasID, *ch.DocumentID)
	}
	err := s.exec(s.client.From("charts").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// ── Forms (direct-input layer) ──────────────────────────────────────────────

func (s *supabaseStore) CreateForm(ctx context.Context, canvasID uuid.UUID, f *Form) (int, error) {
	if f.Fields == nil {
		f.Fields = []FormField{}
	}
	if f.Actions == nil {
		f.Actions = []FormAction{}
	}
	fieldsJSON, err := json.Marshal(f.Fields)
	if err != nil {
		return 0, err
	}
	actionsJSON, err := json.Marshal(f.Actions)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	f.UpdatedAt = now
	row := map[string]any{
		"id":          f.ID.String(),
		"canvas_id":   canvasID.String(),
		"name":        f.Name,
		"description": f.Description,
		"fields":      json.RawMessage(fieldsJSON),
		"actions":     json.RawMessage(actionsJSON),
		"sort_order":  f.SortOrder,
		"created_by":  f.CreatedBy,
		"updated_at":  now.Format(time.RFC3339),
	}
	if err := s.exec(s.client.From("forms").Insert(row, false, "", "minimal", "")); err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) GetForm(_ context.Context, canvasID, id uuid.UUID) (*Form, error) {
	var rows []dbForm
	_, err := s.client.From("forms").
		Select("*", "", false).
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("form %s not found in canvas %s", id, canvasID)
	}
	return toForm(rows[0]), nil
}

func (s *supabaseStore) UpdateForm(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch FormPatch) (int, error) {
	m := map[string]any{}
	if patch.Name != nil {
		m["name"] = *patch.Name
	}
	if patch.Description != nil {
		m["description"] = *patch.Description
	}
	if patch.Fields != nil {
		j, err := json.Marshal(*patch.Fields)
		if err != nil {
			return 0, err
		}
		m["fields"] = json.RawMessage(j)
	}
	if patch.Actions != nil {
		j, err := json.Marshal(*patch.Actions)
		if err != nil {
			return 0, err
		}
		m["actions"] = json.RawMessage(j)
	}
	if patch.SortOrder != nil {
		m["sort_order"] = *patch.SortOrder
	}
	if len(m) == 0 {
		return 0, nil
	}
	err := s.exec(s.client.From("forms").
		Update(m, "minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) DeleteForm(ctx context.Context, canvasID uuid.UUID, id uuid.UUID) (int, error) {
	err := s.exec(s.client.From("forms").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

// SubmitForm applies a resolved batch via the submit_canvas_form RPC, which
// re-validates every target's canvas_id, dedupes by submissionID, applies the
// fan-out, and bumps the version — all in one transaction. Returns the version.
func (s *supabaseStore) SubmitForm(_ context.Context, canvasID uuid.UUID, batch Batch, submissionID string) (int, error) {
	batchJSON, err := json.Marshal(batch)
	if err != nil {
		return 0, err
	}
	params := map[string]any{
		"p_canvas_id": canvasID.String(),
		"p_batch":     json.RawMessage(batchJSON),
	}
	if submissionID != "" {
		params["p_submission_id"] = submissionID
	}
	result := s.client.Rpc("submit_canvas_form", "", params)
	if result == "" {
		return 0, fmt.Errorf("submitForm: empty response — verify migration 0019 is applied")
	}
	if isRpcError(result) {
		return 0, fmt.Errorf("submitForm RPC error: %s", result)
	}
	var v int
	if err := json.Unmarshal([]byte(result), &v); err != nil {
		return 0, fmt.Errorf("submitForm parse: %w (response: %s)", err, result)
	}
	return v, nil
}

// ── Users ─────────────────────────────────────────────────────────────────────

// UpsertUserByGoogleSub inserts a user or, on google_sub conflict, refreshes
// their profile fields + last_seen_at. Returns the resulting row. We never pass
// `id` so the PK default fills on insert and the existing id is preserved on
// conflict.
func (s *supabaseStore) UpsertUserByGoogleSub(_ context.Context, u *User) (*User, error) {
	row := map[string]any{
		"google_sub":   u.GoogleSub,
		"email":        u.Email,
		"display_name": u.DisplayName,
		"avatar_url":   u.AvatarURL,
		"last_seen_at": time.Now().UTC().Format(time.RFC3339),
	}
	var rows []dbUser
	_, err := s.client.From("users").
		Insert(row, true, "google_sub", "representation", "").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no row returned after user upsert")
	}
	return toUser(rows[0]), nil
}

func (s *supabaseStore) GetUserByID(_ context.Context, id uuid.UUID) (*User, error) {
	var rows []dbUser
	_, err := s.client.From("users").
		Select("*", "", false).
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("user not found: %s", id)
	}
	return toUser(rows[0]), nil
}

// GetUserByEmail backs share-by-email. Ilike with no wildcards = case-insensitive
// exact match (Google emails are lowercased, but typed shares may not be).
func (s *supabaseStore) GetUserByEmail(_ context.Context, email string) (*User, error) {
	var rows []dbUser
	_, err := s.client.From("users").
		Select("*", "", false).
		Ilike("email", strings.TrimSpace(email)).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrUserNotFound
	}
	return toUser(rows[0]), nil
}

// UpdateUserDefaultVisibility sets the user's default_canvas_visibility and
// returns the refreshed row (representation) so the caller can echo the fresh
// user back to the client.
func (s *supabaseStore) UpdateUserDefaultVisibility(_ context.Context, id uuid.UUID, visibility string) (*User, error) {
	var rows []dbUser
	_, err := s.client.From("users").
		Update(map[string]string{"default_canvas_visibility": visibility}, "representation", "").
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrUserNotFound
	}
	return toUser(rows[0]), nil
}

// UpdateUserDefaultPublicRole sets the user's default_public_role and returns the
// refreshed row (representation) so the caller can echo the fresh user back.
func (s *supabaseStore) UpdateUserDefaultPublicRole(_ context.Context, id uuid.UUID, role string) (*User, error) {
	var rows []dbUser
	_, err := s.client.From("users").
		Update(map[string]string{"default_public_role": role}, "representation", "").
		Eq("id", id.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrUserNotFound
	}
	return toUser(rows[0]), nil
}

// ── Personal access tokens (migration 0027) ────────────────────────────────────

func toPersonalAccessToken(d dbToken) *PersonalAccessToken {
	id, _ := uuid.Parse(d.ID)
	t := &PersonalAccessToken{
		ID: id, Name: d.Name, LastFour: d.LastFour,
		CreatedAt: parseTime(d.CreatedAt),
	}
	if d.LastUsedAt != nil && *d.LastUsedAt != "" {
		lu := parseTime(*d.LastUsedAt)
		t.LastUsedAt = &lu
	}
	return t
}

func (s *supabaseStore) CreatePersonalAccessToken(_ context.Context, userID uuid.UUID, name, tokenHash, lastFour string) (*PersonalAccessToken, error) {
	var rows []dbToken
	_, err := s.client.From("personal_access_tokens").
		Insert(map[string]any{
			"user_id":    userID.String(),
			"name":       name,
			"token_hash": tokenHash,
			"last_four":  lastFour,
		}, false, "", "representation", "").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no row returned after token insert")
	}
	return toPersonalAccessToken(rows[0]), nil
}

func (s *supabaseStore) ListPersonalAccessTokens(_ context.Context, userID uuid.UUID) ([]*PersonalAccessToken, error) {
	var rows []dbToken
	_, err := s.client.From("personal_access_tokens").
		Select("id,user_id,name,last_four,created_at,last_used_at", "", false).
		Eq("user_id", userID.String()).
		Order("created_at", nil).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	// Newest-first for the UI (DB order is ascending, matching the file idiom).
	out := make([]*PersonalAccessToken, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		out = append(out, toPersonalAccessToken(rows[i]))
	}
	return out, nil
}

func (s *supabaseStore) DeletePersonalAccessToken(_ context.Context, userID, id uuid.UUID) error {
	var rows []dbToken
	// Scope the delete to the owner (user_id) so a caller can only revoke their
	// own tokens; use representation to detect a no-op (wrong owner / missing).
	_, err := s.client.From("personal_access_tokens").
		Delete("representation", "").
		Eq("id", id.String()).
		Eq("user_id", userID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrInvalidToken
	}
	return nil
}

// UserIDByTokenHash resolves the owning user from a token hash and touches
// last_used_at. Returns ErrInvalidToken when no token matches. The hash column
// is UNIQUE, so at most one row comes back.
func (s *supabaseStore) UserIDByTokenHash(_ context.Context, tokenHash string) (uuid.UUID, error) {
	var rows []dbToken
	_, err := s.client.From("personal_access_tokens").
		Select("id,user_id", "", false).
		Eq("token_hash", tokenHash).
		ExecuteTo(&rows)
	if err != nil {
		return uuid.Nil, err
	}
	if len(rows) == 0 {
		return uuid.Nil, ErrInvalidToken
	}
	uid, err := uuid.Parse(rows[0].UserID)
	if err != nil {
		return uuid.Nil, ErrInvalidToken
	}
	// Best-effort last-used bump; never fail auth if it errors.
	_ = s.exec(s.client.From("personal_access_tokens").
		Update(map[string]string{"last_used_at": time.Now().UTC().Format(time.RFC3339)}, "minimal", "").
		Eq("id", rows[0].ID))
	return uid, nil
}

// ── Pending edits ─────────────────────────────────────────────────────────────

func (s *supabaseStore) CreatePendingEdit(_ context.Context, canvasID, entityID uuid.UUID, instruction string) (*PendingEdit, error) {
	var rows []dbPendingEdit
	_, err := s.client.From("pending_edits").
		Insert(map[string]string{
			"canvas_id":   canvasID.String(),
			"entity_id":   entityID.String(),
			"instruction": instruction,
		}, false, "", "representation", "").
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no row returned after pending_edit insert")
	}
	return toPendingEdit(rows[0]), nil
}

func (s *supabaseStore) DeletePendingEdit(_ context.Context, canvasID, id uuid.UUID) error {
	return s.exec(s.client.From("pending_edits").
		Delete("minimal", "").
		Eq("id", id.String()).
		Eq("canvas_id", canvasID.String()))
}

func (s *supabaseStore) ListPendingEdits(_ context.Context, canvasID uuid.UUID) ([]*PendingEdit, error) {
	var rows []dbPendingEdit
	_, err := s.client.From("pending_edits").
		Select("*", "", false).
		Eq("canvas_id", canvasID.String()).
		ExecuteTo(&rows)
	if err != nil {
		return nil, err
	}
	edits := make([]*PendingEdit, 0, len(rows))
	for _, d := range rows {
		edits = append(edits, toPendingEdit(d))
	}
	return edits, nil
}
