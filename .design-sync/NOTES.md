# design-sync notes — Tandem Design System

Synced to claude.ai/design project `e4ec5438-9864-434e-9617-eaa2a1665241`
("Tandem Design System"). https://claude.ai/design/p/e4ec5438-9864-434e-9617-eaa2a1665241

## What this sync IS

`apps/web` is a running **application**, not a component library. This is a
deliberately narrow, off-script **package-shape** sync of the reusable
presentational **design language + atoms** — not the whole app. Four components,
scoped because they render standalone with no API/context coupling:

- `TandemLogo`, `EmptyState`, `AgentToasts`, `AgentPresence`

Deliberately **excluded**: everything auth/canvas/websocket-coupled — the
`modes/*`, the feature dialogs (`QuickLog`, `ConnectModal`, `ShareDialog`), and
`AccessDenied` (imports `AccountMenu`, which fires `fetchMe()` on mount). Don't
re-add these without a provider/mock strategy; they are not clean atoms.

## How the off-script build works (re-sync must preserve all of this)

- **Barrel entry**: `apps/web/_ds_entry.tsx` — named re-exports of the four
  `export default` components so the bundle exposes `window.Tandem.<Name>`.
  `cfg.entry` points at it; PKG_DIR resolves to `apps/web` by walking up from it.
  If a component is renamed/moved, update BOTH the barrel and
  `cfg.componentSrcMap`.
- **Stylesheet**: `apps/web/tandem-ds.css` is a **generated** artifact (committed
  so a fresh clone can build). Regenerate before build whenever `src/index.css`
  or the components' Tailwind classes change:
  ```sh
  cd apps/web && npx tailwindcss -i src/index.css -o /tmp/t.css --minify
  # then prepend the Google Fonts @import line (see top of tandem-ds.css) and
  # write the result to apps/web/tandem-ds.css
  ```
  `cssEntry` must stay under PKG_DIR (containment rule), hence it lives in
  `apps/web`, not `.design-sync/`.
- **Fonts are remote**: Fraunces / Hanken Grotesk / JetBrains Mono load via a
  Google Fonts `@import` at the top of `tandem-ds.css`. Validate reports
  `[FONT_REMOTE]` — expected, not a problem. Nothing is shipped in `fonts/`.
- **`dtsPropsFor` is hand-written** for all four: ts-morph returned
  `[key: string]: unknown` because the components are default exports. The prop
  bodies mirror the real source props (with `CanvasMode`'s union inlined). **If a
  component's props change, update `dtsPropsFor`** or the design agent's contract
  goes stale.

## Preview quirks (baked into config)

- `AgentToasts` uses `position: fixed`. Its preview wraps the stack in a
  `transform: translateZ(0)` "Stage" so the fixed stack is contained by the
  card. `cfg.overrides.AgentToasts = {cardMode:"single", primaryStory:"Stack"}`
  because column/grid layout lets the fixed content escape its cell
  (`[GRID_OVERFLOW]`).
- `AgentPresence` is `hidden sm:flex` — invisible below 640px. Rendered in a wide
  card via `cfg.overrides.AgentPresence = {cardMode:"column", viewport:"760x110"}`.

## Known render warns (check re-sync warns against this list)

- `[FONT_REMOTE]` for the three brand families — expected (remote font host).

## Skipped states

- Time-based animations (TandemLogo entrance, toast drain bar, presence
  scan/read equaliser) are captured statically; `TandemLogo` previews use
  `animate={false}` for deterministic frames. Hover states are not shown.

## Re-sync risks (what can silently rot)

- **`tandem-ds.css` staleness**: it's generated. If component classes or
  `src/index.css` change and it isn't regenerated, the DS ships stale styling
  with no error.
- **`dtsPropsFor` drift**: hand-maintained; not checked against source. A prop
  change in a component won't fail the build.
- **componentSrcMap / barrel drift**: a moved/renamed atom breaks silently until
  the build can't resolve it.
- The playwright cache pinned chromium build **1208** → playwright **1.58.0**.
  A different cached build needs a matching playwright version.
