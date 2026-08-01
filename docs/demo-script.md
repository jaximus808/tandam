# Launch demo v3 — mission control (shot list + staging)

> **Supersedes the two-act "collision" script (TDM-74 revision) and every artifact-era
> cut (the 28s follow-the-agent video, the edit-in-place hero).** What those scripts were
> trying to do is kept: prove the thesis on camera without faking a frame. What changes is
> the story. The collision script made the *failure* the star and the board a side
> character — three terminals racing while the browser watched. This script films the
> thing Tandem is actually for, the way it is actually used every day to build itself:
> **one human, one prompt, five agents — and the board is where you see and run all of
> it.** The board is on camera ~90% of the runtime. Terminals get one shot.
>
> Everything named here is shipped UI: the header fleet chip (`FleetView.tsx`, TDM-47),
> the roster tree (orchestrator → executors via `parentAgentId`), the Feed tab (TDM-48),
> the waiting-orchestrator state (`queue_wait`, TDM-149/150/151), ticket badges, live
> column moves, epic progress. Every prompt is on the 16-tool intent facade.

~60s, three acts. House rules (hard, non-negotiable):

- **NO speed-up, ever.** Sped-up agent footage reads as fake. If a run drags, re-run it.
- **NO cuts inside a beat.** Two cuts allowed, both between acts. Act 3 opens on a
  **labeled** time-skip ("14 minutes later") — the board's own age labels (`· 12m` on
  cards, roster ages) corroborate it on screen, which is what makes a labeled skip honest
  where a hidden splice isn't.
- **Legible ON MUTE.** Autoplay is silent. Every beat carries a burned-in caption.
- **Staged honestly.** The epic is real work from Tandem's own repo, the agents are real
  sessions, the timings are real. If a beat doesn't land, reset and re-run. Never fake
  the frame, never hand-type a tool result.

---

## 1. The story in one line

> You describe the work once, approve it once, and then you *watch five agents do it* —
> live, by name, on a board that tells you who's working, on what, and for how long.

The old villain (two sessions clobbering TODO.md) doesn't disappear — it moves into the
copy, where it belongs. The film's job is the *aspiration*: this is what running agents
feels like when it works.

## 2. Shot list

Timestamps are targets; the runs are real, so drift is fine.

### Act 1 — one prompt, one approval (0:00–0:20)

| # | Time | Frame | What happens | Caption |
|---|------|-------|--------------|---------|
| 1 | 0:00–0:05 | Terminal ~35% left, board (tandemcanvas.com, Board surface) ~65% right. | One prompt, already typed, sent on camera: plan the spec and run it with subagents. Orchestrator `canvas_connect`s — the header fleet chip appears: **`1 agent`**. | `One prompt. Watch the board.` |
| 2 | 0:05–0:12 | Board full frame. | The epic lands in the sidebar; its 6 tasks pop into **Proposed** live, each minting a `TDM-n` ticket badge as it arrives. | `The agent proposes a plan. Nothing runs yet.` |
| 3 | 0:12–0:20 | Board full frame, cursor visible. | The fleet chip now reads **`1 agent · 1 waiting`** — the orchestrator is parked on `queue_wait`. Open the roster once: its row says it's waiting on approval. Human clicks **Approve epic**. All 6 cards flip to **Ready** in one beat. | `You approve once. That's the management overhead.` |

**CUT.**

### Act 2 — the fan-out (0:20–0:48) · one unbroken take

| # | Time | Frame | What happens | Caption |
|---|------|-------|--------------|---------|
| 4 | 0:20–0:28 | Board full frame. | **THE MONEY SHOT, part 1.** The approval *is* the go signal: the parked orchestrator wakes instantly (no re-prompt — `queue_wait` returns) and dispatches. The fleet chip counts up live: `2 agents · 1 working` … up to **`6 agents · 5 working`** as each subagent registers. Cards start sliding Ready → **Working**, each with its claimant's name. | `Approval is the go signal. Five agents spin up.` |
| 5 | 0:28–0:38 | Board left, roster panel open right. | **THE MONEY SHOT, part 2 — the pinned still.** The roster tree: `orchestrator` with five executors nested under it, every row `working · TDM-n · <task title> · Nm`, status dots violet, model tags visible. Hold 4s. Nobody touches anything. | `Who's working, on what, for how long. By name.` |
| 6 | 0:38–0:44 | Board full frame; one card's detail panel open. | Progress lines land live on the working card ("wired the handler", "tests passing") — the heartbeat, on camera. Switch to the roster's **Feed** tab for 2s: the stream of claims and completions. | `Live progress from every agent. No tab-hopping, no babysitting.` |
| 7 | 0:44–0:48 | Board full frame. | First `task_complete` lands: card flips to **Done** — emerald — with the result and commit hash on it. | `Results come back with commit hashes.` |

**CUT — labeled.** Title card over the board: `14 minutes later` (use the real number).

### Act 3 — the drain (0:48–0:60)

| # | Time | Frame | What happens | Caption |
|---|------|-------|--------------|---------|
| 8 | 0:48–0:55 | Board full frame. | Done column full; the last Working card flips on camera if timing allows. Epic counter reads **`6/6 done`**, progress bar full emerald, `drained in Nm` annotation. Card ages (`· 14m`) corroborate the time-skip. | `Six tasks. One approval. 14 minutes.` |
| 9 | 0:55–0:60 | Board full frame, slow hold. | Fleet chip winds down as executors go idle/offline; the roster shows the run's completions. Hold, fade to the URL. | `Your agents, on one board. tandemcanvas.com` |

Total: 9 shots. The claim-collision beat is **not** scripted anymore — with 5 workers and
6 tasks it happens naturally (two workers hit the head of the queue, one wins, the loser
takes the next task). If it lands on camera in Act 2, great — the card briefly showing a
contested claim resolving is a bonus, and the terminal still (§3, fallback) covers the
"how do they not conflict?" reply. Do not stage it, do not wait for it.

---

## 3. The stills

**Pinned image (X thread, og-image candidate): shot 5's frame.** Roster tree open —
orchestrator + five named executors, each with its ticket, title, and age — over a board
mid-swarm with named Working cards behind. That frame *is* the product: nobody else's
screenshot looks like this.

**Reply-guy still ("how does it handle conflicts?"):** the atomic-claim rejection, from
any worker's transcript during the run:

```json
{
  "claimed": false,
  "claimedBy": "tdm-151-worker",
  "message": "This task is already claimed by \"tdm-151-worker\" — another session got it first. Do NOT work on it. Call queue_next and pick the next ready task."
}
```

The string is `claimRejectionMessage` in `apps/mcp-gateway/src/tools.ts`, pinned by
`test/edge-claim.test.ts`. Grab it off any real run (dry-runs count — it just has to be
real); it doesn't need to be from the take.

---

## 4. Staging

### Repo + spec

Use the **Tandem repo itself** — "built with itself" is load-bearing and it's the truth:
this is the actual daily workflow on this project. Work on a throwaway branch
(`demo/launch-run`) so the commits are real but disposable.

`SPEC.md` at repo root, 3 sections → 6 small real tasks (the queue-QoL spec from the v2
script still fits — ticket-prefix warning, `queue_next` ordering, stale-claim age on
cards — **re-verify each is still unimplemented before recording**; a worker that finds
its task already done says so on camera). Tasks must be small enough that a 5-worker
drain finishes in ~10–20 min: that's the real number the time-skip card wears.

### Canvas

Two options, in order of preference:

1. **A dedicated demo canvas seeded by really using it** (default). Fresh canvas, then
   run the full flow once off-camera the day before: the take then shows a board with
   one completed epic already on it — lived-in, not sterile — and ticket numbers that
   aren't suspiciously `TDM-1`. Reset only the demo epic before the take.
2. The real planning canvas (`TEGLQFXR`) is the *most* authentic but carries 28 epics of
   internal planning on camera — only if Jaxon decides the clutter reads as credibility
   rather than noise, and after checking nothing on it shouldn't be public.

Approval policy: **Epic** (the default). Verify no leftover *active* agents from other
sessions — a stale fleet chip count wrecks shot 4's `1 → 6` arc (dormant agents fold
away on their own; anything recently active needs to age out or be cleared).

### CLAUDE.md

The README's Tandem block, verbatim, canvas code swapped in — same as v2. Diff against
README.md before recording rather than trusting any transcription.

### The one prompt (orchestrator, VERBATIM)

```
canvas_connect to the Tandem canvas in CLAUDE.md with role "planner" and name "orchestrator". Read SPEC.md and propose the work as ONE epic with epic_propose, passing all six tasks — two per section — in that same call, recording the spec path, section headings, and spec commit SHA in the epic body. Then call queue_wait with the epicId and wait for my approval — do not end your turn; a timeout answer means nothing yet, call it again. The moment tasks come back ready, dispatch ONE subagent per task in parallel: paste each task's handoff block verbatim, and have each worker connect with role "executor", your agentId as parentAgentId, and a short name of its own. You claim nothing and complete nothing yourself. Report board_status when the queue drains.
```

Why each clause is load-bearing:

- **`role: "planner"` + name `orchestrator`** — registers the root of the fleet tree;
  the roster nests everything under this row.
- **`queue_wait` with the epicId** — produces shot 3's `1 waiting` chip AND shot 4's
  instant wake. This is the beat that kills "I have to prompt it again after approving";
  the approval click is the go signal, on camera. (The pre-`queue_wait` failure mode —
  orchestrator ends its turn, human prompts twice — is exactly what the film must not
  show.)
- **`handoff` verbatim + `parentAgentId` + own names** — the handoff block carries the
  canvas *code* (never the session handle); `parentAgentId` is what forms the tree;
  distinct names are what make the roster read as a team instead of `session-x7f3a2`.
- **One subagent per task, in parallel** — five workers spawning within seconds is what
  makes the chip *count up* on camera instead of stepping.
- **"You claim nothing"** — the orchestrator row must stay a dispatcher on the roster;
  an orchestrator holding a claim muddies the tree.

Worker naming: let the orchestrator name them (`worker-1..5` or per-ticket names both
read fine). Do NOT script worker prompts — the handoff block *is* the worker prompt, and
that's part of the story: the product hands the orchestrator everything the workers need.

### Timing calibration

Dry-run the whole thing once off-camera (this doubles as the canvas seeding). Note the
real numbers: prompt → epic proposed (~1–2 min: trim the take to start at shot 1 just
before `epic_propose` lands, with the prompt visibly sent), approval → chip at 6 agents
(should be under ~60s — this must fit Act 2's unbroken take), drain time (the Act 3
card). If approval → fan-out runs past ~90s, tighten the orchestrator prompt (spawn all
five in a single message) and re-run.

---

## 5. Per-channel cuts

### r/ClaudeAI — full 60s

First-person builder framing, video post, link in comments only.

> **Title:** I run 5 Claude Code subagents at a time now — this is the board I built to
> actually see and manage them
>
> **Body (one paragraph):** Parallel sessions used to mean tab-hopping between terminals
> and, eventually, two agents grabbing the same task and clobbering each other. So I
> moved the queue out of markdown onto a shared board with atomic claims: one session
> plans the spec into an epic, I approve it once in the browser, and the moment I click
> approve the orchestrator (parked on a long-poll, not polling) fans out one subagent
> per task. The video is real time, no speed-up — the fleet panel shows who's working on
> what, by name, with live progress and commit hashes coming back. Built with itself:
> the tasks in the video are from Tandem's own repo. Free, works with any MCP client,
> setup is one `claude mcp add`. Link in comments — happy to answer anything.
>
> **First comment:** tandemcanvas.com — quickstart ~5 min:
> `claude mcp add tandem -- npx -y @jaximus/tandem-mcp`, paste a block into CLAUDE.md, done.

### X — same clip, thread

- **Tweet 1** (clip): "I stopped babysitting terminals. One prompt, one approval, five
  subagents — and a board that shows the whole fleet live. 60 seconds, real time, no
  speed-up:"
- **Tweet 2** (shot-5 still, THE pinned image): "This panel is the product. Every agent,
  by name, with the ticket it holds and how long it's held it. The approval click is the
  go signal — the orchestrator waits on the server, not on me re-prompting it."
- **Tweet 3** (claim-rejection still): "And they can't step on each other: claims are
  atomic, the loser gets told who won and takes the next task. No lockfiles, no
  coordination code."
- **Tweet 4**: "Free, vendor-neutral (anything that speaks MCP).
  `claude mcp add tandem -- npx -y @jaximus/tandem-mcp` → tandemcanvas.com"

### Landing page hero

Unchanged: the hero stays the coded animation (`HeroBoardDemo.tsx`), no video extract.
**Check for contradiction:** the hero currently climaxes on the claim collision; this
film climaxes on the fleet fan-out. They don't conflict (villain vs aspiration), but if
the hero ever reads as "the whole product is conflict-avoidance," the fix is to extend
the hero's timeline toward the fleet view — fix the hero, not the footage.

---

## 6. Recording checklist

**Legibility (mute + feed-size):**

- [ ] 1920×1080, export same. Terminal font ≥ 16pt for its one shot.
- [ ] Browser at 110–125% zoom; roster panel text must survive phone-width compression —
      screenshot shot 5's frame at 400px wide, the ticket ids must be readable.
- [ ] Captions: bottom-third, ≥ 40px, high-contrast pill, one line each.

**Theme: DARK, everywhere.** Set explicitly (account menu / `/me`), don't trust the
`system` default. Board and terminal MATCH; if shooting light, flip both and re-shoot.

**Before hitting record:**

- [ ] Migrations applied / prod healthy (Jaxon) — demo runs against tandemcanvas.com.
- [ ] `queue_wait` live on prod (TDM-149) and the waiting state visible on the board
      (TDM-151) — Act 1/2 hinge on both.
- [ ] `claude mcp list` shows `tandem … ✓ Connected`; `TANDEM_FULL_TOOLS` unset (gateway
      stderr says `intent facade`).
- [ ] Demo canvas seeded (one prior epic done), demo epic reset, approval policy on
      **Epic**, no recently-active stale agents on the fleet.
- [ ] `SPEC.md` sections re-verified unimplemented; `demo/launch-run` branch clean.
- [ ] OS notifications OFF, menu bar clean, tabs closed, bookmarks hidden.
- [ ] Dry-run done; real timings noted for the Act 3 title card.

**Hard constraints (re-read before every take):**

- [ ] NO speed-up, ever.
- [ ] NO cuts inside a beat; two cuts total, the second one labeled with the real
      elapsed time and corroborated by on-screen ages.
- [ ] Every frame works on mute.
- [ ] If a beat whiffs, RESET AND RE-RUN. Never splice, never fake, never hand-type a
      tool result.
