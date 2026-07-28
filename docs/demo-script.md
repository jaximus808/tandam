# Launch demo — shot list + staging

~50s, two acts, one sitting. House rules (hard, non-negotiable):

- **NO cuts inside a run.** One cut allowed: between Act 1 and Act 2.
- **NO speed-up.** Sped-up agent footage reads as fake. If a run drags, re-run it.
- **Legible ON MUTE.** Autoplay is silent. Every beat carries a caption.
- **Staged honestly.** The race is genuinely reproducible — if the collision doesn't land, reset and re-run. Never fake the frame.

---

## 1. Shot list

Timestamps are targets, not gospel — the runs are real, so drift is fine. Captions are burned-in lower-third, short enough to read at feed size.

### Act 1 — the villain (0:00–0:14)

| # | Time | Layout | What happens | Caption |
|---|------|--------|--------------|---------|
| 1 | 0:00–0:03 | Two terminals, 50/50 vertical split, full frame. Same repo visible in both prompts. | Both terminals idle at the Claude Code prompt. Same prompt already typed in both, unsent. | `Two Claude Code sessions. One repo. One TODO.md.` |
| 2 | 0:03–0:10 | Same 50/50 split. | Hit Enter in A, then B (~2s apart). Both read TODO.md; both announce the SAME task ("I'll add the --version flag…"). Hold until both announcements are on screen. | `Both pick the same task.` |
| 3 | 0:10–0:14 | Left terminal grows to ~70%, running `git diff TODO.md`. | The mangled diff: one session's TODO.md update clobbered / interleaved with the other's. Hold 3s on the diff. | `every parallel-session setup, eventually.` |

**CUT** (the only one).

### Act 2 — same repo on Tandem (0:14–0:50)

| # | Time | Layout | What happens | Caption |
|---|------|--------|--------------|---------|
| 4 | 0:14–0:18 | Editor full frame on `SPEC.md`, then orchestrator terminal slides in right 40%. | Camera opens on the spec in the repo. Send the planning prompt in the orchestrator session. | `Same repo. The spec stays in git.` |
| 5 | 0:18–0:23 | Browser (tandemcanvas.com board) full frame, Tasks panel open. | The epic + its 6 tasks appear live as *proposed*, each minting a `TDM-n` ticket. | `One session plans it as an epic.` |
| 6 | 0:23–0:26 | Browser full frame, cursor visible. | Human clicks **Approve epic** once. Every task under it flips to approved. | `Approve once. That's the whole ceremony.` |
| 7 | 0:26–0:31 | Split: browser left 50%, three worker terminals stacked right 50%. | Send the worker prompt to A, B, C within ~5s. Agent chips (terracotta squares) appear in the board header. Terminal A claims TDM-7 (`{ claimed: true … }`). | `Three sessions. One queue.` |
| 8 | 0:31–0:37 | Terminal B grows to ~65% of frame; board stays visible left. | **THE MONEY SHOT.** B tries TDM-7, gets `already claimed by "session-A"`, immediately claims TDM-8. Hold 3s. Freeze-frame candidate — see §3. | `Claims are atomic. The loser just takes the next task.` |
| 9 | 0:37–0:42 | Browser ~60%, terminals right. | First `canvas_task_complete` lands: card flips to Done, result with commit hash visible on the card. | `Results land on the board — commit hashes included.` |
| 10 | 0:42–0:46 | Browser full frame. | A flagged (`requiresApproval: true`) deviation task sits in *proposed* mid-run; human clicks **Approve**; a worker picks it up. | `Deviations wait for a human. Everything else flows.` |
| 11 | 0:46–0:50 | Browser full frame, Tasks panel. | Queue empty, epic counter reads `6/6` (7/7 with the deviation task), everything in Done. Hold, fade. | `Queue drained. tandemcanvas.com` |

Total: 11 shots.

---

## 2. Staging

### Demo repo

Use the **Tandem repo itself** — "built with itself" is load-bearing. Work on a throwaway branch (`demo/launch-run`) so the agents' commits are real but disposable. Two files staged at repo root before recording:

**`SPEC.md`** (real mini-feature, 3 sections — plausible queue-QoL work):

```markdown
# SPEC: Task queue quality-of-life

## 1. Ticket prefix enforcement
Commits for a claimed task must start with its ticket id (e.g. `TDM-7:`).
Add a check to `canvas_task_complete` in apps/mcp-gateway/src/tools.ts: if the
result text contains a commit hash but no `TDM-<n>` prefix mention, append a
warning line to the returned result so the agent self-corrects next time.
Unit-test the detection.

## 2. Queue ordering
`canvas_task_list` currently returns tasks in creation order. Sort approved
tasks oldest-first explicitly (stable), so parallel sessions drain the queue
front-to-back and collisions cluster on the head. Document the ordering in the
tool description. Unit-test the sort.

## 3. Stale-claim visibility
A task claimed by a dead session sits in `executing` forever. In the web Tasks
panel (apps/web/src/components/TasksPanel.tsx), show the claim age next to the
claimant name for executing tasks (e.g. `session-A · 12m`). Pure frontend —
derive from the action's updated timestamp. No new API.
```

Two tasks per section → 6 tasks. Small, real, mergeable-or-droppable.

**`TODO.md`** (Act 1 bait — top item is unambiguous "next", meaty enough that both sessions overlap ~1–2 min):

```markdown
# TODO

- [ ] Add a `--version` flag to the mcp-gateway CLI entry (print the package version and exit)
- [ ] Fix flaky reconnect handling in the web socket client
- [ ] Update the README quickstart screenshots
```

### Canvas

- Fresh canvas at tandemcanvas.com. Grab the 8-char code (`DEMOCODE` below — substitute).
- Share dialog → **Agent task approval** → **Epic** (it's the default; verify the segmented control shows Strict / **Epic** / Auto with Epic selected).
- Board empty: no tasks, no epics, no leftover agents.

### CLAUDE.md

Append the README's block **verbatim** (this is the shipped quickstart — sessions follow the claim protocol because of it). Replace `AB3XK9QZ` with the demo canvas code:

````markdown
## Tandem task queue

The shared work queue for this repo is Tandem canvas `AB3XK9QZ`.

Every session:

1. `canvas_connect` with code `AB3XK9QZ` (once per session).
2. `canvas_task_list` with `state: "approved"` — the ready-to-work queue.
   Do not open with `canvas_state_read`; it pulls the entire canvas.
3. Pick a task, `canvas_task_get` for its hydrated context, then
   `canvas_task_start` to claim it. The claim is atomic: if it returns
   `{ claimed: false, claimedBy }`, another session won — do NOT work on
   that task; go back to the list and take the next one.
4. Do the work. Every commit message for the task starts with its ticket
   ID, e.g. `TDM-7: add rate limiter`.
5. `canvas_task_complete` with a `result` saying what was done and where —
   always include the commit hash(es).

Planning from a spec: when asked to decompose SPEC.md (or any spec file)
into work, propose one epic per spec section with `canvas_epic_add`, then
that section's tasks with `canvas_task_add` passing the epic's id as
`epicId`. In the epic body, record the spec file path, the section heading,
and the current commit SHA of the spec file. One human approval of the epic
approves its tasks (canvas approval policy `epic`, the default). Before
working a claimed task that belongs to an epic, diff the spec section
against the SHA recorded in the epic body: if the section changed since the
epic was planned, do not proceed — flag the task back with
`canvas_task_complete` using `status: "failed"` and an `error` noting the
spec drift, so the plan gets redone against the current spec.

If a task needs to deviate from the approved plan, don't silently do it —
propose the deviation as a new task with `requiresApproval: true` so a
human gates it.
````

MCP registered per README (do this once per machine, verify before recording):

```bash
claude mcp add tandem -- npx -y @jaximus/tandem-mcp
claude mcp list   # tandem: npx -y @jaximus/tandem-mcp - ✓ Connected
```

### Act 1 — reproducing the race honestly

The collision is real because both sessions genuinely read TODO.md at start and genuinely write it at end:

1. Both terminals in the same repo, same worktree, same branch. **No Tandem in play** — temporarily rename the CLAUDE.md Tandem block out of the way (e.g. keep it in a stash) so Act 1 sessions don't discover the queue. Restore before Act 2.
2. Paste the Act 1 prompt into both, unsent. Roll camera. Send A, then B within ~2s.
3. Both read the file before either writes → both pick the top item → both do overlapping work → both rewrite TODO.md from their own stale read at the end. Second writer clobbers or interleaves. That IS the bug; nothing staged beyond timing.
4. End frame: `git diff TODO.md` in terminal A (or `git status` + the file if diff is clean but content lost). If both happened to serialize cleanly (rare — the task takes ~1–2 min and writes land close together), `git checkout TODO.md`, clear both sessions, re-run. Re-running is honest; splicing isn't.

**Act 1 prompt (paste VERBATIM into BOTH terminals):**

```
Pick the next task from TODO.md and do it. When you're done, update TODO.md yourself: check the item off and add a one-line note under it saying what you changed. Do not commit.
```

### Act 2 — orchestrator + workers

Fresh Claude Code sessions (Act 1 sessions closed). Tandem block live in CLAUDE.md.

**Orchestrator prompt (VERBATIM):**

```
Read SPEC.md and propose the work on the Tandem canvas as ONE epic (all three sections under a single epic — this is one feature), with two tasks per section. Follow the CLAUDE.md epic protocol: record the spec path, section headings, and spec commit SHA in the epic body. Do not start any work.
```

> Why "ONE epic": the CLAUDE.md block's default is one epic per section, which would mean three Approve clicks. The prompt scopes it to a single epic so shot 6 is literally one click. Legit — the operator's prompt is allowed to scope the plan; the claim protocol is untouched.

Then (shot 6) click **Approve epic** in the web Tasks panel — the button's tooltip is the shipped copy: *"Approves the epic and every proposed task under it"*. All 6 tasks flip approved in one click.

**Worker prompts (VERBATIM — one per terminal, names differ):**

Terminal A:
```
You are session-A. Pass agentName "session-A" on every canvas_task_start. Work through the approved Tandem queue until it's empty. Take tasks strictly from the top of the list.
```

Terminal B:
```
You are session-B. Pass agentName "session-B" on every canvas_task_start. Work through the approved Tandem queue until it's empty. Take tasks strictly from the top of the list.
```

Terminal C:
```
You are session-C. Pass agentName "session-C" on every canvas_task_start. Work through the approved Tandem queue until it's empty. Take tasks strictly from the top of the list.
```

Pinned names matter: the gateway otherwise mints `session-xxxxxx` random ids, and the money-shot string must read `already claimed by "session-A"`.

**Reproducing the claim collision honestly:** send A, B, C within ~5 seconds. All three run `canvas_task_list` before anyone's `canvas_task_start` lands, so all three see the same head-of-queue task; "strictly from the top" makes them all try it; the server's atomic claim picks exactly one winner. B (or C — whoever loses on camera) gets the rejection and pivots. This races for real every time; if the timing whiffs and nobody collides, reset the tasks to approved (or re-approve a fresh epic) and re-run Act 2 whole. **The mid-act deviation (shot 10):** don't force it — the CLAUDE.md block already instructs sessions to propose deviations with `requiresApproval: true`. The SPEC's section 1 is deliberately underspecified enough (warning-line wording, where the check lives) that a session plausibly proposes one. If no session flags anything by the time 4 tasks are done, drop shot 10 and let shots 9→11 breathe — do NOT fake a deviation.

**Ticket numbers:** a fresh canvas mints tickets sequentially, so the 6 tasks are likely `TDM-1`–`TDM-6`, not TDM-7/TDM-8. The shot list's TDM-7/TDM-8 are placeholders — read the real numbers off the board; captions never hardcode them. (If you want TDM-7 for the aesthetic, burn 6 ticket numbers on a throwaway task-add/delete pass before recording — fine, tickets don't get reused.)

---

## 3. The money shot spec

The frame frozen for the X-thread pinned image: **terminal B, immediately after the failed claim**, showing all three beats in one screen:

1. B's `canvas_task_start` call on the contested task.
2. The tool result. The gateway returns this exact shape (apps/mcp-gateway/src/tools.ts):

   ```json
   {
     "claimed": false,
     "claimedBy": "session-A",
     "message": "This task is already claimed by \"session-A\" — another session got it first. Do NOT work on it. Call canvas_task_list with state \"approved\" and pick the next task."
   }
   ```

   The load-bearing string, verbatim from the shipped code:

   > This task is already claimed by "session-A" — another session got it first. Do NOT work on it. Call canvas_task_list with state "approved" and pick the next task.

3. The pivot: B's next `canvas_task_start` on the following task returning `{ claimed: true, … }` — or at minimum B's own narration ("TDM-1 is claimed by session-A — taking TDM-2").

If Claude Code's transcript collapses the tool result, expand it (Ctrl+O / verbose transcript) before freezing, or freeze on the model's narration line instead — the narration will paraphrase `claimedBy`, which still reads. **Fallback if the wording differs on screen** (older published gateway, or the raw HTTP 409 surfacing): the API layer's string is `task already claimed by session-A` (apps/api/internal/store/store.go) — also freezable, same story. Either way the frame must contain (a) a "claimed by session-A" line in B's terminal and (b) B moving to the next task, with the board visible on the left showing A's chip on the contested card.

---

## 4. Per-channel cuts

### r/ClaudeAI — full 50s

First-person builder framing, video post, **link in comments only** (r/ClaudeAI mods and voters punish link-in-post). Post skeleton:

> **Title:** I got tired of parallel Claude Code sessions fighting over TODO.md, so I built a shared task queue they claim from atomically
>
> **Body (one paragraph):** Two sessions in the same repo will happily pick the same task and clobber each other's TODO.md — first 15 seconds of the video. So I moved the queue out of markdown: a session decomposes the spec into an epic, I approve it once in the browser, and N sessions drain it in parallel — claims are atomic, so the loser just takes the next task, and results land on the board with commit hashes. The spec stays in git; only the churn moves out. Built it with itself (the tasks in the video are from its own repo). Free, works with any MCP client, setup is one `claude mcp add`. Link in comments — happy to answer anything.
>
> **First comment:** tandemcanvas.com — quickstart is ~5 min: `claude mcp add tandem -- npx -y @jaximus/tandem-mcp`, paste a block into CLAUDE.md, done.

### X — same 50s clip, thread

- **Tweet 1** (clip attached): "Every parallel-agent setup eventually hits this: two sessions, same repo, both pick the same task from TODO.md and mangle it. Here's the fix — a shared queue with atomic claims. 50 seconds, no cuts, no speed-up:"
- **Tweet 2** (money-shot still, THE pinned image): "The whole product is this frame. Session B tries a task, gets `already claimed by "session-A"`, and just takes the next one. No coordination code, no lockfiles, no babysitting."
- **Tweet 3**: "Spec stays in git. One approval unlocks the whole epic. Results come back with commit hashes. Built with itself — the tasks in the demo are from Tandem's own repo."
- **Tweet 4**: "Free, vendor-neutral (anything that speaks MCP). `claude mcp add tandem -- npx -y @jaximus/tandem-mcp` → tandemcanvas.com"
- Pin tweet 1 to profile; the tweet-2 still doubles as the reply-guy answer to "how does it handle conflicts?"

### Landing page hero — 15–20s loop

Extract **shots 7–9 (≈0:26–0:42)**: three sessions spin up → claim → collision + pivot → commit hash lands. That's the tightest cause-and-effect arc and it loops cleanly (board activity at both ends). Mute, autoplay, captions burned in (they already are), no controls, `loop playsinline muted`. Do NOT use Act 1 in the hero — the landing visitor gets the villain in copy, not pixels.

---

## 5. Recording checklist

**Legibility (mute + feed-size):**

- [ ] Record at 1920×1080, export same (no downscale of text).
- [ ] Terminal font ≥ 16pt — the money-shot JSON must survive X's compression at phone width. Test: screenshot a terminal frame, view at 400px wide, `claimedBy` must be readable.
- [ ] Browser at 110–125% zoom so board card text ≥ terminal text.
- [ ] Captions: bottom-third, ≥ 40px, high-contrast pill background, one line each.

**Theme: LIGHT, everywhere (terminals included).** One line why: Tandem's board is designed light-first (paper background, terracotta agent chips) and mixed light-board/dark-terminal frames read as two products stitched together.

**Before hitting record:**

- [ ] Migrations applied / prod healthy (Jaxon) — the demo runs against tandemcanvas.com, not localhost.
- [ ] `claude mcp list` in EVERY terminal shows `tandem … ✓ Connected`.
- [ ] Fresh canvas, board empty, approval policy segmented control on **Epic**.
- [ ] `SPEC.md` + `TODO.md` committed on `demo/launch-run`; working tree otherwise clean.
- [ ] Act 1: Tandem block OUT of CLAUDE.md. Act 2: block IN, with the demo canvas code.
- [ ] Sessions authed / no first-run prompts pending in Claude Code (run a throwaway prompt in each terminal, then `/clear`).
- [ ] OS notifications OFF (Do Not Disturb), menu bar clean, browser tabs closed, bookmarks bar hidden.
- [ ] Dry-run Act 2 once off-camera to calibrate timing; then reset the canvas to fresh before the real take.

**Hard constraints (re-read before every take):**

- [ ] NO cuts inside a run. One cut total, between acts.
- [ ] NO speed-up, ever. Long pause? Re-run the act.
- [ ] Every frame must work on mute.
- [ ] If the race doesn't land, RESET AND RE-RUN. Never splice, never fake the collision, never hand-type a tool result.
