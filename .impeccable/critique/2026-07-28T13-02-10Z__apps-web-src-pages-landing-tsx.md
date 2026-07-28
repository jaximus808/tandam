---
target: Landing (Persuade) — apps/web/src/pages/Landing.tsx + components/landing/* + LandingNav, at main 84c839e
total_score: 28
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 0
timestamp: 2026-07-28T13-02-10Z
slug: apps-web-src-pages-landing-tsx
---
⚠️ DEGRADED: partial single-context (second-round Assessment A sub-agent had not returned at synthesis deadline; both first-round isolated sub-agents ran but against a stale pre-restyle tree — all v2 findings below were re-verified line-by-line by the parent against main tip `84c839e`, and the deterministic detector was re-run on v2: clean, exit 0)

**Target**: Landing surface (Persuade) — `apps/web/src/pages/Landing.tsx` + `components/landing/*` + `LandingNav.tsx`, reviewed at main `84c839e` (v2 "Precision Canon" restyle: TDM-15/16). Code-level critique; browser inspection skipped (no browser automation permitted in this environment).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Copy-to-clipboard flashes confirmation (QuickstartSection.tsx:106-111); canvas counter honestly gated ≥50 (Landing.tsx:51, 419-423); no loading states needed on a static page. |
| 2 | Match System / Real World | 4 | Real MCP tool names, real `git diff TODO.md` aftermath (VillainSection.tsx:59-62), plain-language FAQ (Landing.tsx:160-213) — speaks the audience's exact language. |
| 3 | User Control and Freedom | 3 | Cycling H1 cannot be paused except via OS reduced-motion (Landing.tsx:276-280); modals dismissible; reduced-motion honored throughout (index.css:199-237, HeroBoardDemo.tsx:117-126). |
| 4 | Consistency and Standards | 3 | Token-true to DESIGN.md (one accent, Inter, hairlines) — but sign-up band hardcodes `text-indigo-400` + `ring-offset-[#0A0A0B]` (Landing.tsx:542,558), and HeroBoardDemo duplicates state hues as hex instead of importing stateChips (HeroBoardDemo.tsx:211-215). |
| 5 | Error Prevention | 3 | Clipboard fallback for non-secure contexts; stats fetch degrades silently (Landing.tsx:262-273). |
| 6 | Recognition Rather Than Recall | 3 | Section order is a legible argument (pain → mechanism → proof → receipts → try it); "canvas" is used from the hero on but only defined in the FAQ, ~6 screens down (Landing.tsx:204-212). |
| 7 | Flexibility and Efficiency | n/a | Persuade surface; no expert-efficiency dimension. |
| 8 | Aesthetic and Minimalist Design | 3 | The restraint genuinely landed — no grids, no offset shadows, no selection frames. Residual noise: 5 staggered `tandem-rise` entrances in one hero (Landing.tsx:309-429) vs the contract's single fade-up, infinite blur-in word cycle (index.css:228-232), decorative "agent-native" ping badge (LandingNav.tsx:99-105). |
| 9 | Error Recovery | 3 | Little error surface exists; what exists degrades quietly. |
| 10 | Help and Documentation | 3 | FAQ mirrored to JSON-LD, self-serve quickstart with per-client tabs. |
| **Total** | | **28/36** | **Good (78%)** — heuristic 7 n/a, max renormalized to 36. |

## Design Specificity Verdict

**LLM assessment**: Authored. The claim-rejection money shot (HeroBoardDemo.tsx:158-160 — now correctly 1px amber border + ring, no bloom), the TODO.md merge-conflict villain, dogfood board as sole social proof, and truth-first counter gating could not be transplanted to another product. The v2 skin no longer pattern-matches "AI-generated": the banned-pattern sweep is clean (no `surface-grid`, no Fraunces/Hanken, no `shadow-[`, no `backdrop-blur`, no gradient text, no selection-frame/roaming-cursor decorations — all verified absent by grep across the landing scope). The one stretch that still reads category-interchangeable is the sign-up perks band (Landing.tsx:520-570): generic three-perk feature cards in a page that otherwise speaks in receipts.

**Deterministic scan**: `detect.mjs --json` on Landing.tsx + components/landing + LandingNav.tsx (plus board/chrome scope): **0 findings, exit 0**. A positive-control fixture with known anti-patterns produced 2 findings/exit 2, confirming the clean result is genuine, not a scanner no-op.

**Visual overlays**: not attempted — no browser automation permitted in this environment; no user-visible overlay exists.

## Overall Impression
The v2 restyle did what DESIGN.md demanded: the world-class content architecture from v1 survived, and the disqualifying skin is gone. First viewport now matches the contract exactly (headline + subhead left, live demo right, one filled primary button). What remains is a Persuade surface at "Good" — the gap to the Linear/Stripe bar is now measured in motion discipline, decision load at the hero, and a handful of unfinished corners, not in identity.

## What's Working
1. **The demo is engineering-as-design** (HeroBoardDemo.tsx:23-29): pure function of a 20s clock, no imperative cleanup, reduced-motion renders the all-done frame (STATIC_T, line 29). Terminal lines now `whitespace-pre-wrap break-words` (line 185) — the v1 mobile clipping of the money-shot line is fixed.
2. **Contract-literal hero**: accent-colored cycling word as plain text (no box), height-stable grid so the page never shifts (Landing.tsx:313-337), 36px accent primary button with proper `focus-visible` ring (Landing.tsx:374-380).
3. **Truth-first proof discipline**: counter hidden until ≥50 (Landing.tsx:50-51), no fabricated logos, FAQ answers identical to the JSON-LD (Landing.tsx:156-159).

## Priority Issues

- **[P2] First-viewport decision load: ~7 visible actions.** Landing.tsx:352-424 (Create a canvas, Join with a code, "connect an AI agent →", "free account to do more") + LandingNav.tsx:107-143 (3 nav links, Sign in / Dashboard). **Why**: >4 options at the single most important decision point; Jordan doesn't know which door is theirs. **Fix**: drop "free account to do more" from the hero meta-row (the sign-up band already owns that pitch); keep primary + secondary + one text link. **Suggested command**: /impeccable distill
- **[P2] The H1 changes subject mid-read.** Landing.tsx:276-280 cycles Claude→ChatGPT→Cursor→Codex every 4.2s with a blur re-entrance (index.css:228-232); combined with 5 staggered `tandem-rise` delays (Landing.tsx:309, 313, 340, 352, 391, 429) the hero exceeds the contract's "at most a single fade-up per section" and keeps moving forever. **Why**: a reader mid-sentence gets a different sentence; permanent motion in the headline is the last faint "AI-built" tell on the page. **Fix**: cycle through the list once on load then settle; or 7s+ interval, no blur. **Suggested command**: /impeccable quieter
- **[P2] Recents remove control is a hover-only text glyph.** Landing.tsx:460-467: `✕` character, `opacity-0` until `group-hover`, no `focus-visible:opacity-100` — invisible to keyboard users even when focused, unreachable on touch. **Fix**: lucide `X`, add `focus-visible:opacity-100`, always visible below `sm`. **Suggested command**: /impeccable harden
- **[P2] Sign-up band is the page's one templated stretch.** Landing.tsx:520-570: generic perk cards ("Keep your canvases / On every device"), hardcoded `text-indigo-400` (558) and `ring-offset-[#0A0A0B]` (542) instead of the accent token. **Why**: the emotional valley of the scroll — reads like a different, blander company; peak-end matters and this sits right before the close. **Fix**: use the accent token; rewrite perks in receipts-voice (what signing in concretely does to your board). **Suggested command**: /impeccable clarify
- **[P3] Chrome glyph and semantics residue.** Footer `♥` (Landing.tsx:645); `✕` above; "Jump back in" is an `h2` rendering as a 12px eyebrow (Landing.tsx:439-441) — heading smaller than body text; secondary buttons lack the custom accent focus ring the primary has (Landing.tsx:381-386, 618-624 — UA default shows, but treatment is inconsistent). **Suggested command**: /impeccable polish

## Persona Red Flags

**Jordan (First-Timer)**: The headline's subject swaps mid-read (Landing.tsx:276-280). "Canvas" appears in the CTA before it is ever defined (definition lives in FAQ, Landing.tsx:204-212). Seven actions in the first viewport — Jordan hesitates before every unfamiliar click, and there are seven of them.

**Riley (Stress Tester)**: Landing mid-loop means waiting most of a 20s cycle (HeroBoardDemo.tsx:28) to see the claim-rejection beat, with no scrub or replay. The fake terminal text invites copy attempts that fail (it's rendered spans, not selectable code). Wrong-brand colors are gone in v2 (cycling word is uniformly accent) — Riley's v1 screenshot is no longer available.

**Casey (Mobile)**: The mock board forces 3 fixed kanban columns at any width (HeroBoardDemo.tsx:315-316) — ~90px columns on a 360px phone. The recents `✕` is untouchable without hover. The money-shot terminal line now wraps (fixed).

## Minor Observations
- LandingNav "agent-native" badge (LandingNav.tsx:99-105) carries a permanent terracotta ping — the contract's one-pulse budget is reserved for live "working" indicators; this one is decorative.
- HeroBoardDemo column dots hardcode `#0EA5E9`/hue hexes (HeroBoardDemo.tsx:211-215) instead of importing `lib/stateChips.ts` — values match today by copy-paste only.
- Chip radii drift across landing: `rounded-[4px]` vs `rounded` (4px) vs `rounded-[5px]` avatar chips — minor, but the board standardized on 4px via CHIP_BASE.
- Section rhythm is on contract (py-24 = 96px throughout; closing py-28); hero pb-20/pt-16 is the one tighter band — defensible.
- `em.not-italic` for the accent phrase in the closing H2 (Landing.tsx:603) — semantic emphasis used purely as a styling hook.

## Questions to Consider
1. Does the headline need four brand names, or is "Every agent in parallel. Nothing collides." stronger than a slot machine?
2. The sign-up band is the only section that couldn't appear in a changelog screenshot — what would "receipts-voice" account perks look like?
3. If the demo is the argument, should the page open mid-loop at the rejection beat instead of t=0?
