# Tandem design system

Tandem is a shared planning canvas that humans and AI agents co-edit. The visual
language is an **editorial worksurface**: warm paper, warm near-black ink, a
single terracotta accent that means "an agent did this", serif display type, and
flat neo-brutalist offset shadows (no blur). Build with that vocabulary — it's
all real Tailwind classes and a small set of custom classes, no provider or
theme wrapper needed. Just make sure `styles.css` is loaded (it pulls in the
compiled utilities, the custom classes, and the Google-hosted brand fonts).

## The one rule: humans are ink, agents are terracotta

Anything a person authored is **ink** (`text-ink`, `bg-ink`). Anything an AI
agent authored or is doing is **agent** terracotta (`text-agent`, `bg-agent`,
`#C75B39`). This is the core semantic — Claude's presence chips, agent toasts,
and agent cursors all carry `agent`; human content never does. Non-Claude agents
render in `ink` to distinguish them from Claude.

## Colour tokens (Tailwind)

- `paper` `#FBFAF8` — the worksurface background. `bg-paper`.
- `ink` `#1C1917` — warm near-black, all human text/marks. `text-ink`, `bg-ink`.
  Borders use ink at low alpha so hairlines stay warm, not grey:
  `border-ink/10`, `border-ink/15`. Muted text: `text-ink/60`, `text-ink/40`.
- `agent` `#C75B39` — the agent signature terracotta. `text-agent`, `bg-agent`,
  `border-agent/30`.
- **Per-mode accents** (used for the active mode's chrome, not in the tokens):
  map = sky `#0EA5E9`, itinerary = amber `#F59E0B`, docs = violet, sheets =
  emerald, roadmap = rose, charts = indigo. Apply as inline styles from the
  mode, the way `AgentPresence`/`AgentToasts` do.

## Type

- Body / UI: **Hanken Grotesk** — the default sans, inherited everywhere. Use
  `font-brand` to name it explicitly.
- Display (titles, canvas names): **Fraunces** — serif. `font-display`.
- Code / technical labels / uppercase eyebrows: **JetBrains Mono**. `font-code`,
  usually with `uppercase tracking-[0.13em] text-[10px]`.

## The neo-brutalist idiom

Cards and buttons sit on the surface as flat objects with a **hard offset
shadow** (zero blur) and a `1.5px` border:

- `border-[1.5px] border-ink` + `shadow-[3px_3px_0_rgba(28,25,23,0.15)]` — a
  human/control object.
- `shadow-[3px_3px_0_#C75B39]` — an agent object (terracotta offset).
- Larger surfaces: `shadow-[8px_8px_0_rgba(28,25,23,0.06)]`.

## Custom classes (shipped in styles.css)

- `surface-grid-faint` — the faint dot-grid worksurface background.
- `sel-handle` — a small square selection handle; place four at the corners of a
  framed object (see `EmptyState`).
- `btn-press` — press-down affordance for buttons.
- `tandem-mode-enter` — the ease-up entrance when a view mounts.
- `tandem-toast-in`, `tandem-scan`, `tandem-read-bar`, `tandem-orbit-expand` —
  the toast/presence/logo animations.

## Where the truth lives

Read `styles.css` (and the `_ds_bundle.css` it imports) for the exact compiled
classes and tokens; read each component's `.d.ts` for its props and
`.prompt.md` for usage. The four components are `TandemLogo`, `EmptyState`,
`AgentToasts`, `AgentPresence`.

## Idiomatic snippet

```tsx
import { AgentPresence } from "web";

// A canvas header: the worksurface, a Fraunces title, and live agent presence.
<header className="flex items-center gap-3 bg-paper border-b border-ink/10 px-4 py-3">
  <h1 className="font-display text-lg font-medium tracking-tight text-ink">
    Q3 planning
  </h1>
  <div className="ml-auto">
    <AgentPresence
      agents={[{ name: "Claude", isClaude: true }]}
      edit={{ entityId: "row-4", mode: "sheets" }}
      reading={false}
      onJump={() => {}}
    />
  </div>
</header>
```
