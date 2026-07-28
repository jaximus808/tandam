# Launch checklist — clean-machine quickstart run

Run this end-to-end before posting to r/ClaudeAI. The point is to be the stranger:
follow the README Quickstart **verbatim** — copy-paste only, no improvising. Any
step where you have to think is a README bug; fix the README, not the run.

Setup: a fresh machine, or a fresh config dir on this one so no existing MCP
registration leaks in:

```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d)
claude mcp list   # must be empty
```

## Pre-flight

- [ ] **Migrations 0032 (atomic claiming), 0033 (approval policy), 0034 (ticket IDs) applied to prod Supabase.** Expected: all three show in the applied list; a task created on any canvas gets a `ticketId`. If these aren't applied, everything below fails in confusing ways — check this first.
- [ ] **Deployed API/web on main includes the pivot branch.** Expected: the web Tasks panel shows ticket badges (see below); if it doesn't, the deploy predates the feature.
- [ ] **og-image check:** `apps/web/public/og-image.png` may still carry the old artwork. Paste `https://tandemcanvas.com` into a Slack/Discord message or a share-preview checker. Expected: the unfurl image matches the parallel-sessions positioning, not the old canvas art. If not, replace the PNG before posting.

## The quickstart, verbatim

- [ ] **Create a canvas at tandemcanvas.com (logged out / fresh browser profile).** Expected: canvas loads, the 8-char code is findable exactly where the README says (on the canvas / in the URL) without hunting.
- [ ] **`claude mcp add tandem -- npx -y @jaximus/tandem-mcp`** then `claude mcp list`. Expected: `tandem … ✓ Connected`, with **no** env vars set.
- [ ] **Paste the README's CLAUDE.md block into a scratch repo, with a small `SPEC.md` (2–3 sections).** Expected: the block pastes clean (fences don't break), only the canvas code needs editing.
- [ ] **Session A plans:** `claude "read SPEC.md and propose the work on the Tandem canvas"`. Expected: one epic per spec section appears **proposed** in the web UI, each epic body records spec path + section heading + commit SHA, tasks sit under their epic, also proposed.
- [ ] **Epic approval fans out:** approve ONE epic in the web UI. Expected: all of that epic's proposed tasks flip to **approved** together — you never approve a task individually.
- [ ] **Ticket IDs render on the board.** Expected: every task card shows `TDM-1`, `TDM-2`, … per-canvas sequence, no gaps or duplicates.

## Parallel sessions

- [ ] **Two terminals, same scratch repo, `claude "work through the approved Tandem queue until it's empty"` in both.** Expected: both sessions `canvas_connect` successfully and both list the same approved queue.
- [ ] **Exactly one wins a contested claim.** Watch for both sessions going for the same task (with a 2-task queue it's near-guaranteed). Expected: one session claims it; the other visibly reports the loser message — claimed by another session, with the claimant's name — and moves to the next task **without** working the lost one. If both ever proceed on the same task, stop: that's the race 0032 exists to kill.
- [ ] **Claimant name shows on the board.** Expected: the executing card shows who holds the claim, live, no refresh.
- [ ] **Commit messages carry the ticket.** Expected: `git log --oneline` in the scratch repo shows `TDM-n: …` prefixes.
- [ ] **task_complete results show.** Expected: each finished card in the web Tasks panel shows the result summary including the commit hash(es).

## Wrap

- [ ] **Total stranger-path time ≤ 5 minutes** (canvas → mcp add → paste block → first parallel claim). Time it. Over budget or any improvised step → fix the README and re-run the failing item.
- [ ] `unset CLAUDE_CONFIG_DIR` when done.
