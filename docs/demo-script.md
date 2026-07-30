# Launch demo — shot list + staging

> **Reconciled against the shipped product 2026-07-29 (TDM-74).** The 11 shots and the
> house rules are unchanged; four things were corrected. **Theme is DARK** (§5 —
> PRODUCT.md retired the light/terracotta world). **Every prompt is on the intent facade**:
> identity is now minted by `canvas_connect` with `role`/`name`, not by `agentName` on the
> claim, which is what makes the board's fleet tree form. **The board's UI names** are the
> shipped ones (Board surface, not "Tasks panel"). **§4's landing-hero subsection is
> superseded** — the hero is a coded animation now, so there is no hero cut to extract.
>
> The default MCP manifest is the **12-tool intent facade** (`canvas_connect`,
> `context_get`, `queue_next`, `task_get`, `task_claim`, `task_progress`, `task_complete`,
> `task_propose`, `epic_propose`, `doc_write`, `board_status`, `agent_register`). Nothing in
> this doc may name a `canvas_task_*` tool at a session: those still work when called, but
> they are not advertised, so a session cannot see them and will improvise instead.

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
| 5 | 0:18–0:23 | Browser (tandemcanvas.com) full frame on the **Board** surface — left rail's Board item active, epic sidebar + kanban visible. | The epic appears in the sidebar and its 6 tasks land live in the **Proposed** column, each minting a `TDM-n` ticket. Board's rail badge ticks up to **6** — it counts proposed *tasks*, not the epic. | `One session plans it as an epic.` |
| 6 | 0:23–0:26 | Browser full frame, cursor visible. | Human clicks **Approve epic** once. All 6 cards move Proposed → **Ready** in one beat and the rail badge clears. | `Approve once. That's the whole ceremony.` |
| 7 | 0:26–0:31 | Split: browser left 50%, three worker terminals stacked right 50%. | Send the worker prompt to A, B, C within ~5s. Each `canvas_connect` registers, so the header's **fleet chip** counts up to `3 agents` — open the roster once so `session-A/B/C` are on screen by name. Terminal A claims TDM-7 (`{ claimed: true … }`); its card moves to **Working** with A's name on it. | `Three sessions. One queue.` |
| 8 | 0:31–0:37 | Terminal B grows to ~65% of frame; board stays visible left. | **THE MONEY SHOT.** B tries TDM-7, gets `already claimed by "session-A"`, immediately claims TDM-8. Hold 3s. Freeze-frame candidate — see §3. | `Claims are atomic. The loser just takes the next task.` |
| 9 | 0:37–0:42 | Browser ~60%, terminals right. | First `task_complete` lands: card flips to Done, result with commit hash visible on the card. | `Results land on the board — commit hashes included.` |
| 10 | 0:42–0:46 | Browser full frame. | A flagged (`requiresApproval: true`) deviation task sits in *proposed* mid-run; human clicks **Approve**; a worker picks it up. | `Deviations wait for a human. Everything else flows.` |
| 11 | 0:46–0:50 | Browser full frame, Board surface. | Ready column empty, the epic's counter reads `6/6 done` (`7/7 done` with the deviation task) with the progress bar full emerald and a `drained in Nm` annotation next to it. Hold, fade. | `Queue drained. tandemcanvas.com` |

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
Add a check to the `task_complete` handler in apps/mcp-gateway/src/tools.ts
(case "canvas_task_complete", which the facade's task_complete delegates to):
if the result text contains a commit hash but no `TDM-<n>` prefix mention,
append a warning line to the returned result so the agent self-corrects next
time. Unit-test the detection.

## 2. Queue ordering
`queue_next` (apps/mcp-gateway/src/facade.ts) returns approved tasks in
whatever order the API hands them back, then slices to `limit`. Sort them
oldest-first explicitly (stable) before the slice, so parallel sessions drain
the queue front-to-back and collisions cluster on the head. Document the
ordering in the tool description. Unit-test the sort.

## 3. Stale-claim visibility
A task claimed by a dead session sits in `executing` forever, and the board's
task CARD doesn't say for how long — only the detail panel does ("working for
12m"). In apps/web/src/components/TaskBoard.tsx, show the claim age next to
the claimant name on executing cards (e.g. `session-A · 12m`), reusing the
same `ageOf(action.claimedAt)` derivation the detail panel already uses. Pure
frontend, no new API.
```

Two tasks per section → 6 tasks. Small, real, mergeable-or-droppable. All three
sections were re-checked against the shipped code on 2026-07-29 and are genuinely
unimplemented — **re-check before recording**, because a worker that finds its task
already done will say so on camera.

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

Append the README's block **verbatim** (this is the shipped quickstart — sessions follow the claim protocol because of it, and a viewer who copies it from the README gets the same behaviour they just watched). Replace `AB3XK9QZ` with the demo canvas code. The copy below was diffed against README.md on 2026-07-29 — if the README's block moves, re-diff rather than trusting this transcription:

````markdown
## Tandem task queue

The shared work queue for this repo is Tandem canvas `AB3XK9QZ`.

Every session:

1. `canvas_connect` with code `AB3XK9QZ` — once per session. Pass `role`
   ("executor" if you'll work tasks yourself, "planner" if you'll dispatch
   them to subagents) and a `name`. Keep the `session` handle it returns and
   pass it as `session` on every later Tandem call.
2. `queue_next` — the approved, ready-to-work queue. That is the entry point
   for work; don't go looking for it by reading the canvas. (`context_get`
   once if you need to orient on what this canvas is.)
3. Pick one task, `task_get` for its hydrated context (linked notes, roadmap
   items, its epic), then `task_claim` to claim it. The claim is atomic: if
   it returns `{ claimed: false, claimedBy }`, another session won — do NOT
   work on that task; go back to `queue_next` and take the next one.
4. Do the work. Every commit message for the task starts with its ticket
   ID, e.g. `TDM-7: add rate limiter`. On long work, `task_progress` with
   one line per meaningful step — it doubles as a heartbeat, so a task that
   runs past ~15 minutes doesn't become reclaimable underneath you.
5. `task_complete` with a `result` saying what was done and where — always
   include the commit hash(es) — plus `links` to the commit or PR.

Planning from a spec: when asked to decompose SPEC.md (or any spec file)
into work, use `epic_propose` — one epic per spec section, with that
section's tasks passed in the SAME call via `tasks`, so the human approves
once instead of task by task. In the epic body, record the spec file path,
the section heading, and the current commit SHA of the spec file. One human
approval of the epic approves its tasks (canvas approval policy `epic`, the
default); add more tasks to an existing epic later with `task_propose` and
that `epicId`. Before working a claimed task that belongs to an epic, diff
the spec section against the SHA recorded in the epic body: if the section
changed since the epic was planned, do not proceed — flag the task back
with `task_complete` using `status: "failed"` and an `error` noting the spec
drift, so the plan gets redone against the current spec.

If a task needs to deviate from the approved plan, don't silently do it —
propose the deviation with `task_propose` and `requiresApproval: true` so a
human gates it.

Dispatching subagents instead of working tasks yourself? Connect with
`role: "planner"` and paste each ready task's `handoff` block from
`queue_next` into one subagent per task — you dispatch, they claim. Never
claim a task you won't personally do, and never hand a subagent your
`session` handle; the canvas code is what travels.
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
canvas_connect to the Tandem canvas in CLAUDE.md with role "planner" and name "orchestrator". Then read SPEC.md and propose the work as ONE epic with epic_propose (all three sections under a single epic — this is one feature), passing all six tasks — two per section — in that same call. Follow the CLAUDE.md epic protocol: record the spec path, section headings, and spec commit SHA in the epic body. Do not start any work, do not claim anything, and do not spawn subagents.
```

> Why "ONE epic": the CLAUDE.md block's default is one epic per section, which would mean three Approve clicks. The prompt scopes it to a single epic so shot 6 is literally one click. Legit — the operator's prompt is allowed to scope the plan; the claim protocol is untouched.
>
> Why `role: "planner"`, name `orchestrator`: registration is part of `canvas_connect` now, and it's what puts this session on the fleet view as the thing that authored the epic. Naming `epic_propose` explicitly matters too — it creates the epic AND its tasks in one write, so the six tasks appear on the board together (shot 5) instead of trickling in one call at a time.

Then (shot 6) click **Approve epic** on the epic — the primary accent button, on the epic's entry in the Board surface's left sidebar and again in the scoped-epic header above the kanban. Either one flips the epic and every proposed task under it in one click. It has no tooltip, so nothing to hold on; the shot is the click and the column emptying. **Don't use the Proposed column's "Approve all N" button** — same net effect, wrong story: the one-click-per-epic gate is the point.

**Worker prompts (VERBATIM — one per terminal, only the name differs):**

Terminal A:
```
canvas_connect to the Tandem canvas in CLAUDE.md with role "executor" and name "session-A". That name is your identity for this whole session. Then work the approved queue yourself — queue_next, task_claim, do the work, task_complete — until it's empty, taking tasks strictly from the top of the list. Do NOT spawn subagents: you are the worker.
```

Terminal B:
```
canvas_connect to the Tandem canvas in CLAUDE.md with role "executor" and name "session-B". That name is your identity for this whole session. Then work the approved queue yourself — queue_next, task_claim, do the work, task_complete — until it's empty, taking tasks strictly from the top of the list. Do NOT spawn subagents: you are the worker.
```

Terminal C:
```
canvas_connect to the Tandem canvas in CLAUDE.md with role "executor" and name "session-C". That name is your identity for this whole session. Then work the approved queue yourself — queue_next, task_claim, do the work, task_complete — until it's empty, taking tasks strictly from the top of the list. Do NOT spawn subagents: you are the worker.
```

**Why the prompt is shaped like that** — three things in it are load-bearing, and dropping any one of them costs a shot:

- **`name` on `canvas_connect`, not `agentName` on the claim.** Identity is minted at connect time now (TDM-61). A registered session *always* claims under its registered name: `canvas_task_start` deliberately ignores an ad-hoc `agentName` when the session has one, because an override there would detach the claim from the agent row and drop the executor out of the fleet tree mid-task (see the comment at `case "canvas_task_start"` in apps/mcp-gateway/src/tools.ts). So `name: "session-A"` is now the *only* way to pin the string — and the money-shot string must read `already claimed by "session-A"`, not `already claimed by "session-a7f3c2"`. Without a name the gateway mints a random `session-xxxxxx`.
- **`role: "executor"`.** It's what registers the session on the board's fleet view. Three registered executors are what make the header's fleet chip read `3 agents` in shot 7; unregistered sessions claim anonymously and the chip stays empty.
- **"Do NOT spawn subagents."** `queue_next` returns a `_dispatch` nudge telling any session with subagents to fan out instead of claiming. That's correct behaviour for an orchestrator and *fatal* to this demo: three sessions that each dispatch a subagent never race each other, and there is no collision to film. The instruction to work it personally overrides the nudge.

These are top-level sessions, not subagents, so they pass no `parentAgentId` — they show on the fleet view as three peers, which is the picture the shot wants.

**Reproducing the claim collision honestly:** send A, B, C within ~5 seconds. All three run `queue_next` before anyone's `task_claim` lands, so all three see the same head-of-queue task; "strictly from the top" makes them all try it; the server's atomic claim picks exactly one winner. B (or C — whoever loses on camera) gets the rejection and pivots. This races for real every time; if the timing whiffs and nobody collides, reset the queue and re-run Act 2 whole — open each executing card's detail panel and hit **Release** (two-step confirm) to send it back to Ready, or just plan and approve a fresh epic. **The mid-act deviation (shot 10):** don't force it — the CLAUDE.md block already instructs sessions to propose deviations with `requiresApproval: true`. The SPEC's section 1 is deliberately underspecified enough (warning-line wording, where the check lives) that a session plausibly proposes one. If no session flags anything by the time 4 tasks are done, drop shot 10 and let shots 9→11 breathe — do NOT fake a deviation.

**Ticket numbers:** a fresh canvas mints tickets sequentially, so the 6 tasks are likely `TDM-1`–`TDM-6`, not TDM-7/TDM-8. The shot list's TDM-7/TDM-8 are placeholders — read the real numbers off the board; captions never hardcode them. (If you want TDM-7 for the aesthetic, burn 6 ticket numbers on a throwaway task-add/delete pass before recording — fine, tickets don't get reused.)

---

## 3. The money shot spec

The frame frozen for the X-thread pinned image: **terminal B, immediately after the failed claim**, showing all three beats in one screen:

1. B's `task_claim` call on the contested task.
2. The tool result. The gateway returns this exact shape (apps/mcp-gateway/src/tools.ts):

   ```json
   {
     "claimed": false,
     "claimedBy": "session-A",
     "message": "This task is already claimed by \"session-A\" — another session got it first. Do NOT work on it. Call queue_next and pick the next ready task."
   }
   ```

   The load-bearing string, verbatim from the shipped code — `claimRejectionMessage` in `apps/mcp-gateway/src/tools.ts`, pinned by `test/edge-claim.test.ts` and `test/manifest.test.ts`:

   > This task is already claimed by "session-A" — another session got it first. Do NOT work on it. Call queue_next and pick the next ready task.

   It routes to `queue_next`, not `canvas_task_list` (TDM-72): the default manifest is the 12-tool intent facade, so the one instruction the loser gets must name a tool it can actually see. Both surfaces return this identical string — the facade's `task_claim` delegates to `canvas_task_start`.

3. The pivot: B's next `task_claim` on the following task returning `{ claimed: true, … }` — or at minimum B's own narration ("TDM-1 is claimed by session-A — taking TDM-2").

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

### Landing page hero — ~~15–20s loop~~ SUPERSEDED (2026-07-29)

> **There is no hero cut. Do not extract one.** The shipped hero is
> `apps/web/src/components/landing/HeroBoardDemo.tsx` — a coded ~20s animation of exactly
> this arc (two terminals draining a shared queue next to a mini board, climaxing on
> session-B's `claimed: false` and its pivot), pure CSS/JS with no video, no external libs,
> and a static end-state frame under `prefers-reduced-motion`. It beats a video clip on the
> landing page for reasons a re-cut can't fix: it's crisp at any width, weighs nothing, needs
> no poster frame or autoplay negotiation, and stays true when the UI changes.
>
> What this means for recording: **the ~50s clip is for r/ClaudeAI and X only.** Nothing in
> the hero depends on the take, so a re-run costs you nothing on the landing page. It also
> means the hero and the clip must not contradict each other — if the video's collision reads
> differently from the hero's, fix the hero's timeline, not the footage.
>
> Superseded guidance, kept for the record: *extract shots 7–9 (≈0:26–0:42), mute, autoplay,
> captions burned in, no controls, `loop playsinline muted`; never Act 1 — the landing visitor
> gets the villain in copy, not pixels.* The last clause still holds as a rule for the hero
> animation itself: it opens on the queue, not on the mangled TODO.md.

---

## 5. Recording checklist

**Legibility (mute + feed-size):**

- [ ] Record at 1920×1080, export same (no downscale of text).
- [ ] Terminal font ≥ 16pt — the money-shot JSON must survive X's compression at phone width. Test: screenshot a terminal frame, view at 400px wide, `claimedBy` must be readable.
- [ ] Browser at 110–125% zoom so board card text ≥ terminal text.
- [ ] Captions: bottom-third, ≥ 40px, high-contrast pill background, one line each.

**Theme: DARK, everywhere (board and terminals).** One line why: the audience is developers at a dev machine in a frequently dark room, dark mode is first-class in the product, and the light/cream/terracotta world the old LIGHT mandate was written for was retired on 2026-07-28 after testers read it as "AI slop" (PRODUCT.md, Brand commitments). A dark board next to a dark terminal is also the only pairing that doesn't read as two products stitched together — which was the real point of the original rule, and it survives the flip.

- **The rule that outlives the choice:** board and terminals MATCH. If Jaxon overrules this and shoots light, flip *both*, and re-shoot — never mix.
- **Setting it is a manual step, not a default.** The preference is `light | dark | system` and ships as **`system`**, applied as `<html class="dark">` (`apps/web/src/lib/theme.ts`). Set it explicitly to **Dark** in the account menu's theme toggle (or on `/me`) in the recording browser and confirm before rolling — "the OS is dark so the board will be" is how a light frame gets into a take.
- **One residue to watch:** `--color-agent` is still terracotta (`apps/web/src/index.css`, lifted to `224 122 84` in dark). It's scoped to agent presence — the fleet dot and the cursor accent — so it reads as an accent against dark rather than as the old palette. If it looks like a leftover on camera, that's a UI fix, not a theme decision: don't work around it by shooting light.

**Before hitting record:**

- [ ] Migrations applied / prod healthy (Jaxon) — the demo runs against tandemcanvas.com, not localhost.
- [ ] `claude mcp list` in EVERY terminal shows `tandem … ✓ Connected`.
- [ ] Theme set explicitly to **Dark** in the recording browser (account menu toggle / `/me`) — don't rely on the `system` default.
- [ ] `TANDEM_FULL_TOOLS` **unset** (and no `--full-tools` in the MCP config) in every terminal, so each session gets the 12-tool facade the prompts and the CLAUDE.md block are written against. The gateway announces which one it built on stderr — `[tandem] tool manifest: intent facade (12 tools)` vs `facade + full CRUD` — so check the tandem MCP server log once per machine. With the CRUD surface advertised a session can also see ~80 `canvas_*` tools and may reach for one on camera.
- [ ] Fresh canvas, board empty, approval policy segmented control on **Epic**.
- [ ] Fresh canvas has **no leftover agents** — a stale `session-A` on the fleet view makes shot 7's `3 agents` read wrong and can collide with the pinned name.
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
