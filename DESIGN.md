# Tandem — Design System v2 ("Precision Canon")

Replaces the v1 world (cream paper / Fraunces display serif / terracotta-forward /
dotted grids / hard offset shadows). That world was consistently read as AI-generated
by testers and is **anti-reference**: evidence of what the product is, never how it
looks. v2 is the category canon played straight — the craft bar is Linear / Stripe /
Vercel. Nothing clever that costs clarity.

DIRECTION CONTRACT — THESIS: a coordination tool for people who ship; the surface
must feel engineered, not decorated. It refuses the warm-editorial arrangement the
category's AI-built competitors all share. IDENTITY: identity lives in the content
(terminals, receipts, live board); the skin stays invisible — cool neutral ground,
hairline borders, one indigo accent doing all interactive work, mono strictly for
machine text. The skin makes no recognizability claim of its own; if a screen is
memorable, it should be because of what it shows, not how it is dressed. STORY:
"these people sweat details, my agents' work is safe here" → create a canvas. FIRST
VIEWPORT (landing): headline + subhead left, live terminals+board demo right, one
filled primary button. FORM: canon, user-pinned; no seed roll.

## Tokens (the retheme lever — semantic names KEEP, values change)

Defined as CSS variable channels in `apps/web/src/index.css`, exposed via
`tailwind.config.js`. `paper` / `surface` / `ink` / `agent` names stay so existing
markup survives; their VALUES move from warm to cool:

- **paper** (page ground): light `#FAFAFA` (zinc-50); dark `#0A0A0B`.
- **surface** (cards/panels): light `#FFFFFF`; dark `#141416` (one visible step above paper).
- **ink** (text + hairlines-via-alpha): light `#18181B`; dark `#E4E4E7`. Cool, not warm.
- **accent** (NEW, single interactive hue): indigo — light `#4F46E5`, dark `#6366F1`.
  Primary buttons, links, focus rings, active nav, selected states. The ONLY
  saturated hue allowed outside semantic state + agent presence.
- **agent** (agent-presence signature): terracotta survives ONLY here, muted:
  light `#C2571B` → keep, but usage shrinks to presence chips/cursors/attribution.
  Never a ground, never a heading color, never a CTA.
  DECIDED (TDM-19): agent ACTIVITY is terracotta EVERYWHERE — the live
  cursor/halo, the header "editing {mode}" chip, and the reading chip all draw
  from this token. The six per-mode hues (`lib/modeTheme.ts`) are content-level
  semantics only (e.g. docTypes icon tints) and never colour chrome or agent
  presence.
- **Semantic states** (chips, dots, bars — muted, consistent, never neon):
  proposed amber-600, ready sky-600, working violet-600, done emerald-600,
  failed rose-600, rejected zinc-500. Backgrounds at /10 alpha, text at 600 (light)
  / 400 (dark). These six are a closed set — no new hues.

## Type

- **UI + display everywhere: Inter** (variable, via @fontsource-variable/inter —
  the one allowed new dep). Headings are Inter at tight tracking (-0.02em) and
  600/650 weight — the canon look; no display serif anywhere. `font-display`
  and `font-brand` remap to Inter so old markup degrades correctly; delete
  Fraunces + Hanken Grotesk imports.
- **JetBrains Mono** stays, strictly for machine text: tickets (TDM-n), commit
  hashes, terminal content, canvas codes, keyboard hints. Never for labels,
  eyebrows, or nav. (Tracked-mono eyebrow labels are a named slop tell — retire
  the pattern; section eyebrows become 12px Inter 500 uppercase tracking-wide
  in ink/50, used sparingly.)
- Scale: 12 / 13 / 14 (body) / 16 / 20 / 24 / 32 / 44-56 (landing hero only).
  Line-height 1.5 body, 1.2 headings.
- **Metadata contrast floor**: any text set BELOW 12px (ages, counts, tickets,
  provenance, captions, keyboard hints, micro-labels) renders at **ink/50
  minimum** — small + faint is unreadable, especially on dark paper. Sub-12px
  text may be quiet; it may not be both tiny and ghosted. (De-emphasis at these
  sizes comes from weight/size, not alpha below 50.) Placeholders, disabled
  states, and icon-only controls with hover/focus states are exempt. The 12px
  eyebrow spec above (ink/50) already sits on the floor.
- Size floor for labels: nothing below 10px.

## Surfaces & depth

- Borders are the depth system: 1px `ink/10` (light) — in dark, prefer
  `white/10` hairlines. Radius: 6px controls, 8px cards, 10px modals — nothing
  rounder (pill shapes only for tiny state chips).
- Shadows: `shadow-sm` on raised cards, one soft `shadow-lg` for modals/popovers.
  BAN: hard offset "brutalist" shadows, glows, colored shadows (the amber
  money-shot glow in the hero demo may keep a 1px amber border + subtle ring —
  no bloom).
- BAN as slop tells: dotted/grid pattern backgrounds (`surface-grid-faint` dies),
  gradient text, glassmorphism/backdrop-blur panels, decorative blurred blobs,
  emoji in UI chrome, selection-frame/roaming-cursor decorations on marketing
  surfaces (the "you" tag + drag handles on the hero headline dies).
- Density (Operate surfaces): 8px base grid; panel padding 12–16px; table/board
  rows compact. Landing sections: 96–128px vertical rhythm, max-w-6xl.

## Motion

150ms ease-out for hover/focus, 200ms for panels. One pulse allowed: live
"working" indicators. No entrance animations on Operate surfaces; landing keeps
the hero demo timeline + at most a single fade-up per section (no staggered
letter/word animations).

## Components (canon specs)

- **Primary button**: accent fill, white text, 6px radius, 13px/500, 32px (app)
  36px (landing) height; hover darkens 6%; focus ring accent/40 2px offset.
  Secondary: surface + ink/15 border. Ghost: text ink/70 hover surface.
- **Chips** (state/ticket/agent): 11px, 4px radius, /10 bg + 600 text, no borders
  unless interactive. Ticket chips mono 10px ink/50 (the metadata floor).
- **Cards** (board/task): surface, ink/10 border, 8px radius, shadow-sm on hover
  only, 10-12px padding.
- **Inputs**: surface, ink/15 border, focus accent ring; 13px; labels 12px/500 ink/60.
- **Nav/chrome**: paper ground, hairline dividers, active = accent text + accent/8 bg.

## Dark mode

First-class, same token system via `.dark`. Landing UNLOCKS dark (remove
`theme-light` lock): terminals/board demo already read best on dark; verify both.

## Enforcement for agents

Every restyle task: (1) read this file fully; (2) change values/classes toward it,
never invent new hues/faces/radii; (3) grep your diff for banned patterns
(Fraunces, surface-grid-faint, hard shadows `shadow-[`, backdrop-blur, tracked mono
labels) before committing; (4) both themes verified; (5) `pnpm build` green.
