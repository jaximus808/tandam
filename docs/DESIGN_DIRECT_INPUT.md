# Tandem — Design Doc: Direct-Input Layer (agent-defined forms)

> The roadmap item is **"Direct-input layer — update the canvas without the agent"**
> on the planning canvas `PKMLR67T`. This doc is the build reference: it encodes the
> decisions already made so the implementer doesn't relitigate them, and flags the
> handful that are still open.
>
> Status (2026-07-29): **SHELVED — the web surface has been removed.** The
> `QuickLog` dock (`apps/web/src/components/QuickLog.tsx`) and its `submitForm`
> client call were deleted: with the pivot to the agent task queue, a
> human-fills-a-form dock earned no use. The API/store side (`state.forms`,
> `POST /api/canvas/forms/{id}/submit`) is left in place and unreferenced by the
> web app. This doc is kept as the reference if the layer is ever revived.

---

## What we're building & why

Tandem today is agent-authored: a human only changes the canvas by talking to an
agent over MCP. That makes it a passive artifact, and it's the reason "why open the
dashboard instead of just chatting with Claude" has no good answer.

The direct-input layer makes the canvas **touchable without the agent**: the agent
defines a **form** once (fields + where they go), and a human fills that form from a
lightweight (mobile) surface to mutate the canvas directly — log a meal, mark a pin
visited, log a sale. No agent in the submit loop, no automation engine.

This is **not** the ANDR execution layer and **not** "when X happens automatically"
(both deferred). It is an *interaction* layer.

### The thesis in one line

> `forms.actions` (jsonb recipe, by name/ref) **+** submitted values **→** Go resolver
> **→** `batch` (jsonb, by id/concrete) **→** RPC executes in one transaction.

---

## Architecture: three deterministic transforms

The agent never hand-writes the stored mapping. It expresses **intent**; we compile.
The whole system is three pure, independently testable transforms:

```
AUTHOR (once):   intent ──compile(intent, state)──▶ DSL            (stored jsonb)
                  ▲ scaffold(sheet): state ─▶ draft intent (read-only, stores nothing)
SUBMIT (per tap): DSL + values ──resolve(dsl, values, state)──▶ batch ──▶ RPC
```

- **`scaffold`** — reads an existing sheet, returns a *draft intent* (one explicit
  field+binding per column). Stateless, idempotent. The easy on-ramp.
- **`compile`** — validates the intent against live canvas state and expands it into
  the canonical DSL. Run once, at definition time. The reliability layer (Part B).
- **`resolve`** — at each submit, evaluates the DSL against submitted values + state
  into a flat, concrete, scope-checked `batch`. Pure.
- The **RPC** applies the `batch` atomically. It knows `sheet_rows`/`pins`, **never**
  the DSL — by the time SQL runs, every name is a uuid and every value is concrete.

### Persistence model — three lifetimes

| Thing | Lifetime | Where |
|---|---|---|
| Form definition (the recipe) | persistent, written once by agent | new `forms` table |
| Submitted values | transient (one request) | never stored as form data |
| The effect (new row / patched pin) | persistent | existing `sheet_rows` / `pins` |

The direct-input layer adds **exactly one new table** (`forms`). Everything a
submission produces reuses the existing entity model, so it broadcasts, exports, and
renders with zero new plumbing.

---

## Constraints discovered in the codebase

1. **No client-side transactions.** The store talks to Supabase over PostgREST
   (`supabase-community/supabase-go`); every mutation is its own HTTP call ending in
   `bump_canvas_version` (an RPC). Atomic fan-out therefore **must** go through a
   Postgres function (the pattern `copy_canvas` / `bump_canvas_version` already use).
2. **Name→id resolution already exists.** `resolveRowData(cols, data)` in
   `store/supabase.go` maps column **name → id** on write. The mapping can reference
   columns by name; survives the agent recreating columns; readable in storage.
3. **Provenance matters.** HTTP mutations default `createdBy:"agent"` and broadcast
   `lastChangeBy:"agent"` (fires the agent cursor). Submits are **human** input →
   must broadcast `"user"` via `broadcastStateBy(..., "user")` so the cursor doesn't
   fire and the recurrence signal counts correctly.
4. **Auth is free.** `POST /api/mcp/auth` already exchanges a canvas *code* → canvas
   JWT. A mobile form page does the same exchange; no Google login needed.

---

## Data model

### New `forms` table (migration `0019`)

```sql
CREATE TABLE forms (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  fields      JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- input schema (Field[])
  actions     JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- canonical DSL (Action[])
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_by  TEXT        NOT NULL DEFAULT 'agent',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX forms_canvas_id_idx ON forms(canvas_id);
CREATE TRIGGER forms_updated_at BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

`fields` + `actions` are two JSONB columns (edited/validated separately). Add
`Forms map[string]*Form` to `store.CanvasState` so the web reads forms with the rest
of state and the dock renders from live state.

### The stored DSL (`forms.actions`)

The canonical internal representation. The agent never writes this directly.

```ts
Action {
  op:     "sheet.row.append" | "sheet.row.upsert" | "pin.patch"
  target: { sheet: string } | { pin: string }      // sheet by name, pin by id
  set:    Binding[]
  match?: Binding[]                                  // upsert only
  inc?:   string[]                                   // upsert only: column ids treated as increments
}
Binding { column: string; value: ValueExpr }         // column resolved name→id at submit
ValueExpr =
  | { from: <fieldKey> }                             // a submitted value
  | { computed: "today" | "now" }                    // server-evaluated
  | { literal: <scalar> }                            // constant
```

---

## Part A — Intent schema (the authoring artifact)

What `scaffold` emits and `define` accepts. Explicit bindings only — **no runtime
name-matching** (scaffold does the matching once, visibly, in the draft).

```ts
Intent {
  name:         string            // required, 1..80
  description?: string
  fields:       Field[]           // required, 1..20
  writes:       Write[]           // required, 1..8
}

Field {
  key:       string               // required, ^[a-z][a-z0-9_]{0,31}$, unique
  label:     string               // required, 1..60
  type:      "text" | "number" | "date" | "select" | "checkbox"
  required?: boolean              // default false
  options?:  string[]             // required iff select; 1..20, unique, 1..40 chars each
  default?:  string | number | boolean   // type-compatible; select ⇒ ∈ options
  placeholder?: string            // text/number only
}

Write = SheetWrite | PinWrite     // discriminated by `sheet` vs `pin`

SheetWrite {
  sheet:   string                 // required, sheet NAME (resolved against state)
  mode:    "append" | "upsert"
  match?:  string[]               // required iff upsert; entries ⊆ keys(columns)
  columns: { [columnName: string]: Source }   // required, 1..50
  inc?:    string[]               // upsert only; ⊆ keys(columns); target must be numeric
}

PinWrite {
  pin: string                     // required, pin id
  set: { [k in "color"|"label"|"body"|"pinType"]?: Source }   // whitelist only
}

// EXACTLY ONE key — fully explicit, MCP-inputSchema-typeable, no string parsing.
Source =
  | { field:    string }          // must equal a declared field.key
  | { computed: "today" | "now" }
  | { literal:  string | number | boolean }
```

Canonical example:

```json
{
  "name": "Log a meal",
  "fields": [
    { "key": "meal",     "label": "Meal",     "type": "text",   "required": true },
    { "key": "calories", "label": "Calories", "type": "number" }
  ],
  "writes": [
    { "sheet": "Meals", "mode": "append",
      "columns": {
        "Meal":     { "field": "meal" },
        "Calories": { "field": "calories" },
        "Date":     { "computed": "today" }
      } }
  ]
}
```

---

## Part B — Compile validation catalog

`compile(intent, state)` returns:

```ts
CompileResult { ok: boolean; errors: Diagnostic[]; warnings: Diagnostic[]; formId?: string }
Diagnostic   { code; severity:"error"|"warning"; path; message; suggestion?; meta? }
```

`ok === (errors.length === 0)`. `define` stores **iff** `ok`. Warnings never block.
Checks run in **phases**; we **report all independent errors** (only same-node
dependents are skipped) so the agent fixes everything in one more turn.

### Phase 1 — Form structural
| Code | Sev | Trigger |
|---|---|---|
| `FORM_NAME_REQUIRED` | error | name empty |
| `FORM_NAME_TOO_LONG` | error | >80 |
| `FORM_NO_FIELDS` | error | fields empty |
| `FORM_TOO_MANY_FIELDS` | error | >20 |
| `FORM_NO_WRITES` | error | writes empty |
| `FORM_TOO_MANY_WRITES` | error | >8 |

### Phase 2 — Field structural
| Code | Sev | Trigger | Suggestion |
|---|---|---|---|
| `FIELD_KEY_INVALID` | error | key fails regex | offer slugified key |
| `FIELD_KEY_DUPLICATE` | error | repeated key | — |
| `FIELD_LABEL_REQUIRED` | error | no label | — |
| `FIELD_TYPE_INVALID` | error | type ∉ enum | list allowed |
| `FIELD_SELECT_NO_OPTIONS` | error | select w/o options | — |
| `FIELD_OPTIONS_IGNORED` | warning | options on non-select | — |
| `FIELD_OPTION_DUPLICATE` | warning | dup option | — |
| `FIELD_DEFAULT_TYPE` | error | default wrong type | — |
| `FIELD_DEFAULT_NOT_OPTION` | error | select default ∉ options | list options |

### Phase 3 — Write internal refs (no state yet)
| Code | Sev | Trigger | Suggestion |
|---|---|---|---|
| `WRITE_KIND_UNKNOWN` | error | neither sheet nor pin | — |
| `WRITE_MODE_INVALID` | error | mode ∉ {append,upsert} | — |
| `WRITE_COLUMNS_EMPTY` | error | no columns | — |
| `UPSERT_MATCH_REQUIRED` | error | upsert w/o match | — |
| `UPSERT_MATCH_NOT_COLUMN` | error | match ⊄ columns keys | list columns |
| `INC_NOT_COLUMN` | error | inc ⊄ columns keys | list columns |
| `INC_ON_APPEND` | warning | inc with mode=append | — |
| `SOURCE_SHAPE` | error | Source not exactly-one-key | — |
| `SOURCE_FIELD_UNKNOWN` | error | `{field:x}`, x ∉ fields | did-you-mean + list fields |
| `SOURCE_COMPUTED_UNKNOWN` | error | computed ∉ {today,now} | list allowed |
| `PIN_SET_KEY` | error | set key ∉ whitelist | list settable |

### Phase 4 — State resolution (against live canvas)
| Code | Sev | Trigger | Suggestion |
|---|---|---|---|
| `SHEET_NOT_FOUND` | error | sheet name unresolved | did-you-mean + list sheets |
| `SHEET_AMBIGUOUS` | error | >1 sheet same name | rename to disambiguate |
| `COLUMN_NOT_FOUND` | error | columns key ∉ sheet cols | did-you-mean + list columns |
| `PIN_NOT_FOUND` | error | pin id/label unresolved | list pins |

### Phase 5 — Type compatibility
| Code | Sev | Trigger |
|---|---|---|
| `LITERAL_NOT_COERCIBLE` | error | literal can't coerce to column type (known now ⇒ hard error) |
| `COMPUTED_COLUMN_TYPE` | warning | @today/@now → non-date column |
| `FIELD_COLUMN_TYPE` | warning | field type ≠ column type (submit may reject) |

### Phase 6 — Advisory (never block)
| Code | Sev | Trigger |
|---|---|---|
| `FIELD_UNUSED` | warning | field never referenced by a write |
| `REQUIRED_FIELD_UNUSED` | warning | required + unused |
| `COLUMN_UNFILLED` | info | sheet column not written by the form |

### Rendered example (failing)
```json
{
  "ok": false,
  "errors": [
    { "code": "SOURCE_FIELD_UNKNOWN", "severity": "error",
      "path": "writes[0].columns.Calories",
      "message": "source field 'calorie' is not a declared field.",
      "suggestion": "did you mean 'calories'?",
      "meta": { "fields": ["meal", "calories"] } },
    { "code": "COLUMN_NOT_FOUND", "severity": "error",
      "path": "writes[0].columns.Dat",
      "message": "column 'Dat' not found in sheet 'Meals'.",
      "suggestion": "did you mean 'Date'?",
      "meta": { "columns": ["Meal", "Calories", "Date"] } }
  ],
  "warnings": []
}
```

### Catalog design notes
- **"Did you mean"** — deterministic: Levenshtein ≤ 2 (case-insensitive) over the
  candidate set; the full `available` list always rides in `meta`. Same intent →
  same diagnostics.
- **Report-all, phase-ordered** — structural before state-resolution (state checks
  assume valid shape). Same-node dependents skipped only when a prerequisite fails.
- **Shared coercion table** (used by `LITERAL_NOT_COERCIBLE` *and* the submit-time
  resolver, so author-time and runtime agree):
  `text`→string · `number`→parseFloat, reject NaN · `date`→ISO `YYYY-MM-DD` ·
  `checkbox`→bool (`true/false/1/0`) · `select`→must ∈ options.
- **`@today` timezone** — use the **canvas timezone** (we already store event
  `timezone`), fall back to UTC. A meal logged at 11:50pm must land on the right day.
- The **same `compile`** runs inside `scaffold` (against the draft) so issues surface
  before the agent even edits.

---

## Submit path: resolver → batch → RPC

### `resolve(form, values, state, now) → Batch` (pure Go)
1. Validate `values` against `fields` (required, type, select membership).
2. For each action in order: resolve target (sheet name→id; pin id; **scope to this
   canvas**), evaluate each `ValueExpr`, coerce to the target column's type.
3. For `upsert`: scan `state.SheetRows` for a row matching `match`; emit a
   patch-by-id (found) or an insert (none) — **the match decision happens in Go**, so
   SQL never needs `ON CONFLICT`/matching.

```go
type Batch struct {
    Inserts []RowInsert `json:"inserts"`
    Patches []Patch     `json:"patches"`
}
type RowInsert struct { SheetID string `json:"sheet_id"`; Data map[string]any `json:"data"` }
type Patch struct {
    RowID *string            `json:"row_id,omitempty"`
    PinID *string            `json:"pin_id,omitempty"`
    Set   map[string]any     `json:"set,omitempty"`
    Inc   map[string]float64 `json:"inc,omitempty"`
}
```

### RPC `submit_canvas_form(canvas_id, batch jsonb) → version`
One transaction (a plpgsql function body): for each insert/patch, **re-validate the
target's `canvas_id` server-side** (defense in depth), apply, then
`bump_canvas_version`, return version. Any `raise` rolls back the whole batch.
Typed to the mutation kinds — **never** parses the DSL.

### HTTP
`POST /api/canvas/forms/{id}/submit` — body `{ values, submissionId? }`, canvas JWT.
Handler: `GetCanvasState` → `resolve` → `SubmitForm` (RPC) → `broadcastStateBy(_, "user")`.

---

## Authoring flow (scaffold + define)

1. `canvas.form.scaffold({ sheet })` → draft intent (1 explicit field+binding per
   column) + hints. **Stores nothing.** Needs an existing sheet (agent creates the
   sheet first via existing `sheet.add` if needed — scaffold stays read-only).
2. Agent edits the draft (rename, mark required, swap an asked-for field for
   `{computed:"today"}`, add extra `writes` for multi-action / pin-patch).
3. `canvas.form.define(intent)` → `compile` validates against state, expands to DSL,
   stores, broadcasts. Returns `formId` + warnings.

Single high-level `define` call (not incremental `field.add`/`action.add`) — avoids
the UUID-threading round-trip friction the itinerary build hit. Scaffold seeds the
common "log a row" case; the agent hand-writes intent for non-sheet forms.

---

## Access UX (built — prototype)

`apps/web/src/components/QuickLog.tsx`, rendered in `App.tsx` inside the (now
`relative`) content area. One dock, two densities, user-toggled + remembered
(`localStorage`):
- **collapsed** — chip rail in the right gutter, **overlays** the mode, toast-confirms.
- **expanded** — full-height right column, **in-flow so the mode reflows narrower**
  beside it (watch the chart move as you log); forms on top, running log below.
- **mobile** — FAB → bottom sheet.
Line icons (lucide), no emojis. Currently mock data; wire to real `state.Forms` +
`POST /forms/{id}/submit` when the backend lands. Known rough edges: Leaflet needs
`invalidateSize()` on expand; the width swap isn't animated.

---

## Decisions locked

1. **Declarative mapping + deterministic interpreter**, *not* LLM-at-submit. Submit
   is instant, free, deterministic, offline-capable. Agent intelligence is spent once
   at definition time. (Matches MCP-surface policy: opinionation lives in the agent.)
2. **Mapping stored as a JSONB document on the form**, *not* a normalized
   `form_actions` binding table (that's the EAV/over-normalization trap — it shreds a
   naturally-nested doc into rows you re-assemble, and adds reads).
3. **Explicit `Source` union — no runtime name-matching.** Scaffold generates explicit
   bindings; predictability over terseness.
4. **Atomicity via a Postgres `submit_canvas_form` RPC**, with the *brain in Go*: the
   resolver computes a concrete `batch`; SQL is a dumb, typed, scope-checking applier.
5. **`compile` + `resolve` are two pure Go transforms**, heavily unit-tested.
6. **One new table (`forms`).** Effects land in existing `sheet_rows`/`pins`.
7. **Submits tag `createdBy:"user"`** and broadcast `"user"`.
8. **Auth reuses the existing code→JWT exchange** — no new login for mobile.
9. **Single `define` call + `scaffold` on-ramp.**

## Open decisions (not yet locked)

- **Action vocabulary for v1** *(parked: "talk it through more")* — append-only
  (`sheet.row.append` + `pin.patch`) vs. also `sheet.row.upsert` + increment. The
  flagship meal example ("advance the day + running total") is genuinely a two-action
  fan-out and needs upsert+inc; pure logs (sales / workouts / mark-visited) are
  append-only. **Decide via the actual first dogfood form.** A cheap middle path: keep
  writes append-only and compute "today's total" as a **read-time rollup in the dock**,
  deferring persisted totals until chart aggregation exists.
- **Submission logging** — default off (the row is the record). Consider a tiny
  `(canvas_id, submission_id)` idempotency guard early; a full `form_submissions` log
  would directly answer the recurrence question (worth it once the loop is real).
- **Generic `entity.patch` vs per-kind ops** — pins/events/roadmap/notes all have a
  patch shape. One `patch` op with a per-kind settable-field whitelist would be fewer
  ops than `pin.patch`, `event.patch`, … Decide when the second patch target appears.

## Build order (thin slice)

1. Migration `0019` + store types (`Form`, `FormField`, `FormAction`, patches) +
   `Forms` in `CanvasState` + supabase CRUD/load.
2. **`resolve` + `Batch` + unit tests** (the riskiest logic first).
3. RPC `submit_canvas_form` (sized to the chosen vocabulary) + `SubmitForm` store method.
4. **`compile` + validation catalog + unit tests.**
5. Handlers: form CRUD (`define`/`update`/`delete`) + `POST /forms/{id}/submit`.
6. MCP tools: `canvas.form.scaffold` / `define` / `update` / `delete`.
7. Wire `QuickLog` to real `state.Forms` + the submit endpoint (drop mock data).
8. Dogfood **one** real form from a phone for 2–3 weeks (the actual validation).

## Non-goals (v1)

Automation / "when X happens"; the ANDR execution layer; chart group-by/aggregation;
LLM-at-submit; image/file inputs; multi-canvas forms; per-user form permissions.
