---
target: Board (Operate) — apps/web/src/components/TaskBoard.tsx + TasksPanel + AgentPresence + lib/stateChips + chrome seams, at main 84c839e
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-07-28T13-02-18Z
slug: apps-web-src-components-taskboard-tsx
---
⚠️ DEGRADED: partial single-context (second-round Assessment A sub-agent had not returned at synthesis deadline; both first-round isolated sub-agents ran but against a stale pre-restyle tree — all v2 findings below were re-verified line-by-line by the parent against main tip `84c839e`, and the deterministic detector was re-run on v2: clean, exit 0)

**Target**: Board surface (Operate) — `apps/web/src/components/TaskBoard.tsx` + `TasksPanel.tsx` + `AgentPresence.tsx` + `lib/stateChips.ts`, plus shared-chrome seams (`SiteHeader.tsx`, `DocumentTabs.tsx`, `DocumentExplorer.tsx`), reviewed at main `84c839e` (v2 "Precision Canon" restyle: TDM-15/17/18). Code-level critique; browser inspection skipped (no browser automation permitted in this environment).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Live WS state everywhere; claimant chips; filtered counts; the working pulse is the contract's one allowed pulse. |
| 2 | Match System / Real World | 4 | Proposed/Ready/Working/Done, TDM tickets, commits-as-chips, "drained in 22m" epitaphs (TaskBoard.tsx:145) — the user's exact vocabulary. |
| 3 | User Control and Freedom | 3 | Release ("for when the agent session died mid-task", TasksPanel.tsx:375) and re-queue explain semantics before the click; Esc layering; but approve/reject has no undo, and cards can't be dragged — the kanban is read-mostly, which surprises. |
| 4 | Consistency and Standards | 3 | `lib/stateChips.ts` is now the single source (imported by TaskBoard, TasksPanel, AgentPresence) with proper 600-light/400-dark split — the v1 duplication is fixed. Remaining seams: `border-ink/5` hairlines (TaskBoard.tsx:952, 955, 1224) vs `/10` elsewhere — near-invisible on dark `#0A0A0B` where the contract prefers `white/10`; `⚡` text glyph in a lucide-icon system. |
| 5 | Error Prevention | 4 | Two-step confirms on every destructive action; optimistic batch-approve overlay reverts on failure; payload round-trip handled deliberately. |
| 6 | Recognition Rather Than Recall | 2 | The j/k/x keyboard-triage vocabulary (TasksPanel.tsx:215-267) has no visible hint anywhere — not even a tooltip in v2; the three filter selects read as identical unlabeled lozenges until opened (TaskBoard.tsx:874-902 — aria-labels present, visual labels absent). |
| 7 | Flexibility and Efficiency | 3 | Batch approve + shift-range + keyboard triage is power-user grade; shortcuts work only inside the Tasks panel, not on the Board surface where the same user lives. |
| 8 | Aesthetic and Minimalist Design | 3 | Dense, quiet, 8px-grid-adjacent; compact cards on contract radius; residual: 9px labels (TaskBoard.tsx:1326, AgentPresence.tsx:95) below any floor in the type scale. |
| 9 | Error Recovery | 3 | Real server messages surfaced; failed state offers a retry path; feedback surfaces now have dark variants (TasksPanel.tsx:538, 783, 788). |
| 10 | Help and Documentation | 2 | Thorough tooltips, but no shortcut sheet, no onboarding, and the board empty state names the Tasks panel without a control to open it (TaskBoard.tsx:940-946). |
| **Total** | | **31/40** | **Good (78%)** |

## Design Specificity Verdict

**LLM assessment**: Authored, unmistakably. Epic-timeline-as-navigation-lens with age-out that "holds its timeline slot if it finishes under you" (TaskBoard.tsx:45, 463-467), sidebar doubling as an approval inbox, "drained in 22m", release/re-queue verbs, the keyboard-triage focus-ownership guard (TasksPanel.tsx:125-128) — product-mechanism-shaped UI no template produces. v2 execution now matches: the shared six-hue closed set lives in one file with dark variants, killing the v1 P0 (illegible dark chips) and the drift risk at once.

**Deterministic scan**: `detect.mjs --json` over TaskBoard, TasksPanel, AgentPresence, SiteHeader, DocumentTabs, DocumentExplorer, EmptyState, stateChips: **0 findings, exit 0** (positive-control fixture confirmed the scanner detects known anti-patterns).

**Visual overlays**: not attempted — no browser automation permitted; no user-visible overlay exists.

## Overall Impression
The strongest Operate surface this product has shipped. Interaction architecture is above the bar; the restyle held onto it while replacing the skin. What separates it from Linear-grade now is keyboard completeness: the mouse path is excellent and the keyboard path is 80% built and 0% advertised — cards, tabs, and hover-revealed controls are the missing 20%.

## What's Working
1. **`lib/stateChips.ts` is exactly what the contract ordered** (stateChips.ts:20-62): one closed set, `/10` backgrounds, 600/400 light-dark text, one CHIP_BASE shell — consumed by all three surfaces including the presence chips.
2. **Sidebar-as-approval-inbox with keyboard parity** (TaskBoard.tsx:731-735, 758-762): timeline entries are real `role="button"` elements with `tabIndex`, key handlers, and inset accent focus rings.
3. **State design with no rug-pulls**: epic age-out pinning (TaskBoard.tsx:463-467), optimistic overlay revert, unpersisted filters vs persisted scope — the right calls, made deliberately.

## Priority Issues

- **[P1] Kanban cards are keyboard-invisible.** TaskBoard.tsx:640-646: the card is a `div` with `onClick` — no `role`, no `tabIndex`, no key handler, no focus style. The sidebar rows got the full treatment (731-735); the cards were forgotten. A keyboard user can see the board but cannot open any card on it (workaround: the same tasks via TasksPanel). **Fix**: `role="button" tabIndex={0}` + Enter/Space + `focus-visible:ring-2 ring-inset ring-accent/40`, mirroring line 714. **Suggested command**: /impeccable harden
- **[P1] DocumentTabs: doc tabs are draggable `div`s beside a real `<button>` Board tab.** DocumentTabs.tsx:104-113 vs :79. Keyboard doc-switching is impossible; close is `opacity-0` hover-only (:140-146); rename is double-click-only. This is a coherence seam inside a single chrome component. **Fix**: make tabs buttons (or a proper `role="tablist"`), reveal close on `focus-visible`, add rename via context/Enter. **Suggested command**: /impeccable harden
- **[P2] Detail slide-over declares `aria-modal` but manages no focus.** TaskBoard.tsx:1213-1221: focus is not moved in on open, not trapped, not restored on close; screen-reader and keyboard users remain in the background page. **Fix**: focus the dialog (or first control) on open, trap Tab, restore trigger focus on close. **Suggested command**: /impeccable harden
- **[P2] Hover-only edit/delete controls never appear for keyboard users.** TasksPanel.tsx:744-762: `opacity-0` until `group-hover/task`, no `focus-visible:opacity-100`; and `hover:bg-rose-50` (line 758) is the panel's last light-only class — a glowing light swatch in dark mode. **Fix**: add focus-visible reveal + `dark:hover:bg-rose-500/10`. **Suggested command**: /impeccable polish
- **[P2] The keyboard vocabulary is a secret.** j/k/x triage (TasksPanel.tsx:215-267) and "/" search focus (TaskBoard.tsx:604-609) have no visible or even tooltip-level hint in v2. **Why**: heuristic 6 at a 2 — the feature most likely to make Alex adopt the tool is undiscoverable. **Fix**: one muted hint row in the panel footer ("j/k move · x select · a approve") + a "?" shortcut sheet. **Suggested command**: /impeccable clarify

## Persona Red Flags

**Alex (Power User)**: Shortcuts exist but are undiscoverable and stop working outside the Tasks panel. Cards don't drag — every kanban since Trello trained that hand; nothing signals "the agents move the cards, you steer" (the honest model). The three filter selects (TaskBoard.tsx:874-902) are visually identical gray lozenges requiring open-to-discover.

**Sam (Accessibility)**: Cannot open kanban cards (P1). Cannot switch doc tabs (P1). Detail dialog drops them behind an `aria-modal` wall (P2). Edit/delete controls invisible when tabbed to (P2). ProgressBar (TaskBoard.tsx:162, used at 775, 823) communicates done/working ratio by color alone — no text alternative. AgentPresence swarm toggle is a clickable `div` (AgentPresence.tsx:134-137). Positives: filter selects have aria-labels; sidebar rows and section toggles are properly focusable; state chips pair color with text labels.

## Minor Observations
- `⚡` as a UI glyph in AgentPresence (:108, 115, 198) — DESIGN.md bans emoji in chrome; the codebase's icon language is lucide (`Zap` exists).
- Agent presence is `hidden sm:flex` (AgentPresence.tsx:131) — mobile users get zero "who's here" in a product whose pitch is the live board.
- The editing-status chip styles itself from per-mode hues via inline `style` (AgentPresence.tsx:204-219, `modeTheme.ts`) — the chrome still runs six mode hues against the contract's one-accent thesis; a deliberate TDM-18 decision worth an explicit note in DESIGN.md if it's intended to survive.
- 9px labels: TaskBoard.tsx:1326, AgentPresence.tsx:95 — below the 10px chip floor, borderline legibility.
- Board empty state (TaskBoard.tsx:940-946) explains the flow well but offers no control to open the Tasks panel it names, and no "ask your agent" starter affordance.
- `border-ink/5` dividers (TaskBoard.tsx:952, 955, 1224): at dark ink `#E4E4E7`, a 5% white hairline on `#0A0A0B` is sub-perceptible; contract prefers `white/10` in dark.

## Questions to Consider
1. Is the kanban a board or a dashboard? If state changes belong to agents, stop borrowing drag-implying grammar — style the columns as a live feed with levers, and the "cards don't drag" surprise disappears.
2. What would it take for the entire approve-triage loop to be doable eyes-on-board, hands-on-keyboard — and would that demo better than the mouse path?
3. The presence system is the product's soul and it's hidden on mobile — what's the 44px version of "two sessions are working right now"?
