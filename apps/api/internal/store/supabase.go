package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	supa "github.com/supabase-community/supabase-go"
	"github.com/google/uuid"
)

const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func generateCode() string {
	b := make([]byte, 8)
	for i := range b {
		b[i] = codeChars[rand.Intn(len(codeChars))]
	}
	return string(b)
}

// ── DB row types (snake_case = Supabase column names) ─────────────────────────

type dbCanvas struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Mode      string `json:"mode"`
	Version   int    `json:"version"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type dbPin struct {
	ID        string  `json:"id"`
	PinType   string  `json:"pin_type"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	Label     *string `json:"label"`
	Body      *string `json:"body"`
	Color     *string `json:"color"`
	CreatedBy string  `json:"created_by"`
	UpdatedAt string  `json:"updated_at"`
}

type dbEvent struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	StartTime string  `json:"start_time"`
	EndTime   *string `json:"end_time"`
	PinID     *string `json:"pin_id"`
	CreatedBy string  `json:"created_by"`
	UpdatedAt string  `json:"updated_at"`
}

type dbNote struct {
	ID         string   `json:"id"`
	Body       string   `json:"body"`
	ImageRefs  []string `json:"image_refs"`
	ParentID   *string  `json:"parent_id"`
	ParentKind *string  `json:"parent_kind"`
	CreatedBy  string   `json:"created_by"`
	UpdatedAt  string   `json:"updated_at"`
}

type dbPendingEdit struct {
	ID          string `json:"id"`
	EntityID    string `json:"entity_id"`
	Instruction string `json:"instruction"`
	CreatedAt   string `json:"created_at"`
}

// Used for GetCanvasState — one request with embedded child tables.
type dbCanvasWithChildren struct {
	dbCanvas
	Pins         []dbPin         `json:"pins"`
	Events       []dbEvent       `json:"events"`
	Notes        []dbNote        `json:"notes"`
	PendingEdits []dbPendingEdit `json:"pending_edits"`
}

// ── Converters ────────────────────────────────────────────────────────────────

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
	return &Canvas{ID: id, Code: d.Code, Name: d.Name, Mode: d.Mode, Version: d.Version,
		CreatedAt: parseTime(d.CreatedAt), UpdatedAt: parseTime(d.UpdatedAt)}
}

func toPin(d dbPin) *Pin {
	id, _ := uuid.Parse(d.ID)
	return &Pin{ID: id, Kind: "pin", PinType: d.PinType, Lat: d.Lat, Lng: d.Lng,
		Label: d.Label, Body: d.Body, Color: d.Color,
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
}

func toEvent(d dbEvent) *Event {
	id, _ := uuid.Parse(d.ID)
	ev := &Event{ID: id, Kind: "event", Title: d.Title, Start: parseTime(d.StartTime),
		CreatedBy: d.CreatedBy, UpdatedAt: parseTime(d.UpdatedAt)}
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
	return ev
}

func toNote(d dbNote) *Note {
	id, _ := uuid.Parse(d.ID)
	n := &Note{ID: id, Kind: "note", Body: d.Body,
		ImageRefs: d.ImageRefs, ParentKind: d.ParentKind,
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

func (s *supabaseStore) CreateCanvas(_ context.Context, name string) (*Canvas, error) {
	for range 10 {
		code := generateCode()
		var rows []dbCanvas
		_, err := s.client.From("canvases").
			Insert(map[string]string{"code": code, "name": name}, false, "", "representation", "").
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
		return toCanvas(rows[0]), nil
	}
	return nil, fmt.Errorf("failed to generate unique canvas code after 10 attempts")
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

// GetCanvasState uses PostgREST embedded selects — one HTTP request for everything.
func (s *supabaseStore) GetCanvasState(_ context.Context, canvasID uuid.UUID) (*Canvas, *CanvasState, []*PendingEdit, error) {
	var rows []dbCanvasWithChildren
	_, err := s.client.From("canvases").
		Select("*,pins(*),events(*),notes(*),pending_edits(*)", "", false).
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
		Version: canvas.Version,
		Mode:    canvas.Mode,
		Pins:    make(map[string]*Pin, len(row.Pins)),
		Events:  make(map[string]*Event, len(row.Events)),
		Notes:   make(map[string]*Note, len(row.Notes)),
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

	edits := make([]*PendingEdit, 0, len(row.PendingEdits))
	for _, d := range row.PendingEdits {
		edits = append(edits, toPendingEdit(d))
	}
	return canvas, state, edits, nil
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

// ── Pins ──────────────────────────────────────────────────────────────────────

func (s *supabaseStore) CreatePin(ctx context.Context, canvasID uuid.UUID, pin *Pin) (int, error) {
	row := map[string]any{
		"id": pin.ID.String(), "canvas_id": canvasID.String(),
		"pin_type": pin.PinType, "lat": pin.Lat, "lng": pin.Lng,
		"label": pin.Label, "body": pin.Body, "color": pin.Color,
		"created_by": pin.CreatedBy,
	}
	err := s.exec(s.client.From("pins").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdatePin(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch PinPatch) (int, error) {
	m := map[string]any{}
	if patch.PinType != nil { m["pin_type"] = *patch.PinType }
	if patch.Lat != nil     { m["lat"] = *patch.Lat }
	if patch.Lng != nil     { m["lng"] = *patch.Lng }
	if patch.Label != nil   { m["label"] = *patch.Label }
	if patch.Body != nil    { m["body"] = *patch.Body }
	if patch.Color != nil   { m["color"] = *patch.Color }
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

func (s *supabaseStore) CreateEvent(ctx context.Context, canvasID uuid.UUID, ev *Event) (int, error) {
	row := map[string]any{
		"id": ev.ID.String(), "canvas_id": canvasID.String(),
		"title": ev.Title, "start_time": ev.Start.Format(time.RFC3339),
		"created_by": ev.CreatedBy,
	}
	if ev.End != nil {
		row["end_time"] = ev.End.Format(time.RFC3339)
	}
	if ev.PinID != nil {
		row["pin_id"] = ev.PinID.String()
	}
	err := s.exec(s.client.From("events").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateEvent(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch EventPatch) (int, error) {
	m := map[string]any{}
	if patch.Title != nil { m["title"] = *patch.Title }
	if patch.Start != nil { m["start_time"] = patch.Start.Format(time.RFC3339) }
	if patch.End != nil   { m["end_time"] = patch.End.Format(time.RFC3339) }
	if patch.PinID != nil { m["pin_id"] = patch.PinID.String() }
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

func (s *supabaseStore) CreateNote(ctx context.Context, canvasID uuid.UUID, n *Note) (int, error) {
	refs := n.ImageRefs
	if refs == nil {
		refs = []string{}
	}
	row := map[string]any{
		"id": n.ID.String(), "canvas_id": canvasID.String(),
		"body": n.Body, "image_refs": refs,
		"parent_kind": n.ParentKind, "created_by": n.CreatedBy,
	}
	if n.ParentID != nil {
		row["parent_id"] = n.ParentID.String()
	}
	err := s.exec(s.client.From("notes").Insert(row, false, "", "minimal", ""))
	if err != nil {
		return 0, err
	}
	return s.bumpVersion(ctx, canvasID)
}

func (s *supabaseStore) UpdateNote(ctx context.Context, canvasID uuid.UUID, id uuid.UUID, patch NotePatch) (int, error) {
	m := map[string]any{}
	if patch.Body != nil       { m["body"] = *patch.Body }
	if patch.ImageRefs != nil  { m["image_refs"] = patch.ImageRefs }
	if patch.ParentKind != nil { m["parent_kind"] = *patch.ParentKind }
	if patch.ParentID != nil   { m["parent_id"] = patch.ParentID.String() }
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
