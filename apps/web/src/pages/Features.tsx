import type { ReactNode } from "react";
import LandingNav from "../components/LandingNav";
import TandemLogo from "../components/TandemLogo";
import { spaLink } from "../lib/spaNav";

/* ─────────────────────────────────────────────────────────────────────────────
   /features — "What Tandem can do", the public capability reference.

   This is the web projection of docs/FEATURES.md: same pillars, same order, one
   tight line per capability. It is a REFERENCE, not a second landing pitch —
   there is no hero, no testimonial, no CTA past the standard nav. Someone
   arrives here already interested and wants to know what is actually in the
   product; the job is answering that in as few words as the truth allows.

   Shape follows from that. The reading unit is a ROW, not a card: a hairline
   grid of name → one line, dense enough to scan a pillar in a few seconds and
   uniform enough that scanning never has to re-learn a layout. Pillars
   alternate paper / surface bands for rhythm, exactly as WhyTandem does, and
   the section index up top exists because a ten-pillar reference that can only
   be read top-to-bottom is a document, not a reference.

   Honest limits are their own section on purpose, mirroring the doc's rule: a
   capability list that quietly rounds a convention up to a guarantee is worse
   than no list. Everything here was read out of the tree — if the code stops
   being true, this page is wrong and must change with it.
   ───────────────────────────────────────────────────────────────────────────── */

interface Props {
  onBack: () => void;
  onOpenMCP: () => void;
  onShowCanvases: () => void;
  onShowSettings: () => void;
  onOpenCanvas: (code: string) => void;
  // /about and /why-tandem — optional, mirroring how WhyTandem treats /about.
  // The nav links are real anchors, so without a handler the browser just
  // navigates normally instead of routing in-app.
  onAbout?: () => void;
  onWhy?: () => void;
}

const WEBSITE_URL = "https://www.jaxonp.com/";

/** Machine text — tool names, endpoints, states, env vars. Mono, per canon. */
function M({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded border border-ink/10 bg-ink/[0.05] px-1.5 py-px font-code text-[0.82em] text-ink/85">
      {children}
    </code>
  );
}

/** Bolded lead-in inside a feature line. */
function B({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-ink">{children}</strong>;
}

interface Feature {
  name: string;
  line: ReactNode;
}

interface Pillar {
  id: string;
  n: string;
  title: string;
  lead: ReactNode;
  groups: { heading?: string; features: Feature[] }[];
}

/* ── The inventory ───────────────────────────────────────────────────────────
   Ordered as docs/FEATURES.md is ordered, so the two can be diffed by eye. */
const PILLARS: Pillar[] = [
  {
    id: "queue",
    n: "01",
    title: "The task queue",
    lead: (
      <>
        The execution primitive is a task row. One table serves tasks and epics; six states and
        their legal transitions are enforced by the server, not by convention.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Six states",
            line: (
              <>
                <M>proposed</M> → <M>approved</M> / <M>rejected</M> → <M>executing</M> →{" "}
                <M>done</M> / <M>failed</M>. <M>failed → approved</M> exists only as a human
                re-queue, never as an agent move.
              </>
            ),
          },
          {
            name: "Ticket ids",
            line: (
              <>
                A per-canvas counter allocated by an atomic reservation that hands back{" "}
                <em>n</em> consecutive numbers in one round trip, so a batch insert cannot
                collide. <M>TDM-</M> is a render prefix; only the integer is stored.
              </>
            ),
          },
          {
            name: "Refs work anywhere an id does",
            line: (
              <>
                <M>TDM-21</M>, <M>tdm-21</M>, <M>#21</M>, <M>21</M> and the raw uuid all resolve
                to the same task. An unknown but well-formed ref answers <M>task_not_found</M>,
                not "invalid id".
              </>
            ),
          },
          {
            name: "Epics",
            line: (
              <>
                A named batch that tasks point back into. Epics are never claimed and never
                executed — <M>epic_propose</M> creates the container and its tickets in one call,
                so a human approves once instead of ticket by ticket.
              </>
            ),
          },
          {
            name: "The ready queue is FIFO",
            line: (
              <>
                Approved agent tasks, oldest first. <B>There is no priority field</B> — a queue
                that can be jumped is a queue nobody trusts.
              </>
            ),
          },
          {
            name: "Ticket quality warnings",
            line: (
              <>
                Five non-blocking codes — <M>no_surface_named</M>, <M>no_done_condition</M>,{" "}
                <M>may_exceed_one_sitting</M>, <M>context_not_linked</M>,{" "}
                <M>context_duplicated</M> — evaluated on the ticket's text before any write, and
                again on the board while a human edits it.
              </>
            ),
          },
        ],
      },
      {
        heading: "Claims, leases and contention",
        features: [
          {
            name: "Claiming is atomic",
            line: (
              <>
                One conditional update, so of two racing claimers exactly one gets a row back.{" "}
                <B>Losing is normal and is answered as data</B> — the loser is re-read to be told
                who holds it and why it lost.
              </>
            ),
          },
          {
            name: "A 15-minute lease",
            line: (
              <>
                Overridable per deployment via <M>CLAIM_TTL_MINUTES</M>; <M>0</M> disables expiry
                entirely.
              </>
            ),
          },
          {
            name: "Expiry is lazy",
            line: (
              <>
                Nothing sweeps. A lapsed lease looks live until a rival asks for the task, at
                which point a second atomic update rebinds it — no background job to fall behind.
              </>
            ),
          },
          {
            name: "Heartbeats extend the lease",
            line: (
              <>
                <M>task_progress</M> restamps the lease, holder-only, in SQL — but deliberately
                does not move the claim's start time, so "working for 40 minutes" stays honest.
              </>
            ),
          },
          {
            name: "Generation fencing",
            line: (
              <>
                Each fresh lease mints a per-task counter. Presenting a superseded generation on
                a later write is refused with one shape — <M>409</M> plus a reason — from{" "}
                <B>every</B> write path: complete, fail, progress, patch, move, release, requeue,
                delete.
              </>
            ),
          },
          {
            name: "The contention trail",
            line: (
              <>
                Recorded on the task, capped at 20 events with repeats coalesced, and read back
                as two strictly separated kinds: <B>raced</B> (a claim lost at the door) versus{" "}
                <B>fenced</B> (a write refused because the lease was superseded).
              </>
            ),
          },
          {
            name: "The tap-out contract",
            line: (
              <>
                Every losing path carries <M>tapOut: true</M> with a reason and a next step — one
                boolean to branch on instead of prose — and a per-process ledger refuses a second
                attempt at a task you already lost without even racing.
              </>
            ),
          },
        ],
      },
      {
        heading: "Board reads",
        features: [
          {
            name: "A real long poll",
            line: (
              <>
                <M>queue_wait</M> parks server-side (1–60s, default 25s) and returns the instant
                work is approved. Waiters are an in-process registry woken by a signal — there is
                no database polling behind it.
              </>
            ),
          },
          {
            name: "Epic rollup",
            line: (
              <>
                Counts, activity window, drained flag, summary and the list of bounced tickets —
                all derived at read time. Compact by default, per-ticket lines on request.
              </>
            ),
          },
          {
            name: "Cheap state reads",
            line: (
              <>
                The default canvas read is a per-kind count summary, not the canvas. Projecting
                specific kinds is a query parameter; the full dump is the explicit escape hatch.
              </>
            ),
          },
          {
            name: "Inbound CI status",
            line: (
              <>
                A build system can move a ticket with its own vocabulary —{" "}
                <M>started · progress · completed · failed</M> — and lands on the board as{" "}
                <M>external</M> rather than as a generic agent.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "gates",
    n: "02",
    title: "Approval gates",
    lead: (
      <>
        Agents propose; humans promote. A canvas sits on exactly one policy, set by the owner
        alone, and birth-time approval is stamped by the server from provenance the caller cannot
        forge.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "requiresApproval overrides the policy",
            line: (
              <>
                A task flagged <M>requiresApproval</M> lands <M>proposed</M> under every policy,{" "}
                <M>auto</M> included — the agent's own "I deviated, look at this" signal.
              </>
            ),
          },
          {
            name: "An unreadable policy falls back to strict",
            line: <>Fail closed. "We could not tell" resolves to "a human decides".</>,
          },
          {
            name: "Approval provenance is server-derived",
            line: (
              <>
                <M>human</M>, <M>agent:&lt;name&gt;</M>, <M>policy:epic</M>, <M>policy:auto</M> —
                so a reader can tell a cascade from a decision. There is no{" "}
                <M>approvedBy</M> body field anywhere in the API.
              </>
            ),
          },
          {
            name: "The epic cascade",
            line: (
              <>
                Batch-approves an epic's proposed tasks, detached after the response and
                idempotent, so an approve retry repairs a failed cascade. Off for <M>strict</M>{" "}
                and <M>peer</M>.
              </>
            ),
          },
          {
            name: "Reject stays human-only",
            line: (
              <>
                On every policy. So does bulk approve and born-approved — a single conditional
                update cannot see per-row authorship, so it is not offered to agents at all.
              </>
            ),
          },
        ],
      },
      {
        heading: "The content gate",
        features: [
          {
            name: "Approval binds to content",
            line: (
              <>
                Content is <B>title and body only</B>. Editing an approved or executing task{" "}
                <B>reverts it to proposed</B>, clears the claim, and audits the reversion — you
                cannot approve one ticket and have another one execute.
              </>
            ),
          },
          {
            name: "Finished work is locked",
            line: (
              <>
                Editing a <M>done</M> or <M>failed</M> ticket is refused, including via the side
                door of a combined state-plus-content patch.
              </>
            ),
          },
          {
            name: "Non-content writes are silent",
            line: (
              <>
                Progress, links, assignee, linked context and epic membership never cost an
                approval. The audit trail itself is server-owned.
              </>
            ),
          },
          {
            name: "Gate metrics",
            line: (
              <>
                A pre-work intervention rate derived from state and the audit trail, per canvas
                and per epic — and it ships its own caveat text in the same response, explicitly
                not a target.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "review",
    n: "03",
    title: "Peer review",
    lead: (
      <>
        Off by default. On a <M>peer</M> canvas the gate moves from the human to a{" "}
        <em>different</em> registered agent — one verb, two outcomes, and a short list of things
        it deliberately cannot do.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "pass",
            line: (
              <>
                Approves a still-<M>proposed</M> task into the ready queue. Both identities are
                server-derived: the reviewer from the request's auth context, the proposer from
                the stored provenance.
              </>
            ),
          },
          {
            name: "changes_requested",
            line: (
              <>
                Sends <M>done</M> work back to the queue with a <B>required</B> reason, stored
                verbatim — so whoever picks it up next reads why without asking anyone.
              </>
            ),
          },
          {
            name: "No self-review, ever",
            line: (
              <>
                You cannot pass your own proposal or bounce your own completion. Unknown
                provenance on either side <B>fails closed</B>.
              </>
            ),
          },
          {
            name: "Refusals are data",
            line: (
              <>
                A stable code plus a next step, surfaced as <M>reviewed: false</M> rather than an
                error — <M>peer_self_approval</M>, <M>rework_self_review</M>,{" "}
                <M>rework_reason_required</M> and a dozen more.
              </>
            ),
          },
          {
            name: "Cross-model review",
            line: (
              <>
                Optionally require the reviewer to be running a different model. Ids are
                normalised for case, provider prefix and variant suffix.{" "}
                <B>
                  The model is self-asserted, so this is an honesty rail, not a guarantee — and
                  it says so on every refusal.
                </B>
              </>
            ),
          },
          {
            name: "A reviewer cannot end a task",
            line: (
              <>
                Both of its moves are reversible with one human click. Rejection is not, so it
                stays with the person whose project it is — along with epics, bulk approval and
                born-approved.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "orchestration",
    n: "04",
    title: "Orchestration",
    lead: (
      <>
        What turns an approved queue into running work: paste-ready handoffs, a wait that is not
        a poll, and webhooks that can start a process on your machine.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Handoff blocks",
            line: (
              <>
                <M>queue_next</M> attaches a paste-ready brief to every ready task, so an
                orchestrator dispatches one subagent per task without composing anything. It
                carries the canvas <B>code</B>, never the caller's session handle — a worker on
                the planner's handle claims as the planner and the fleet tree collapses.
              </>
            ),
          },
          {
            name: "Connect and register in one call",
            line: (
              <>
                <M>canvas_connect</M> takes <M>role</M>, <M>name</M>, <M>model</M> and{" "}
                <M>parentAgentId</M>, upserting on name so re-registering returns the same
                identity. A bad parent never fails the connect — it is reported as data.
              </>
            ),
          },
          {
            name: "Waiting shows on the board",
            line: (
              <>
                A timeout keeps the identity marked waiting for a grace window and pushes a live
                ping, so a parked agent is visibly parked rather than indistinguishable from a
                hung one.
              </>
            ),
          },
          {
            name: "Five webhook events",
            line: (
              <>
                <M>task.approved</M>, <M>task.completed</M> (done <em>or</em> failed — there is no{" "}
                <M>task.failed</M>), <M>task.claim_expired</M>, <M>task.returned</M>,{" "}
                <M>task.rejected</M>. Claiming, deletes, payload edits, release and requeue are
                deliberately silent.
              </>
            ),
          },
          {
            name: "Signed, retried, dead-lettered",
            line: (
              <>
                HMAC-SHA256 over timestamp and raw body, 60s replay window, constant-time compare.
                Four attempts at 1m / 10m / 1h, then dead-lettered; a stable delivery id is the
                dedupe key across retries.
              </>
            ),
          },
          {
            name: "SSRF guard in the dialer",
            line: (
              <>
                Post-DNS and pre-connect, so DNS rebinding is caught — loopback, RFC1918,
                link-local (including the cloud metadata address), CGNAT and multicast are
                blocked, and redirects are never followed.
              </>
            ),
          },
          {
            name: "Webhook config is human-only by construction",
            line: (
              <>
                Cookie-session <em>and</em> canvas-owner, so a canvas token, access token or OAuth
                bearer all fail. There is no MCP tool for any of it: an agent must not be able to
                point the canvas at an endpoint it controls.
              </>
            ),
          },
          {
            name: "tandem-mcp listen",
            line: (
              <>
                A loopback-only receiver that turns an approval into a process. Trailing-edge
                debounce folds an epic-approval burst into one trigger, and single-flight means
                events landing mid-run merge into one pending batch instead of forking a second
                orchestrator.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "context",
    n: "05",
    title: "Documents and context",
    lead: (
      <>
        A canvas is a bag of named documents that humans edit live and agents read scoped. The
        point is that an agent picking up a ticket gets its context in one call.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Named document tabs",
            line: (
              <>
                <M>map</M>, <M>notes</M>, <M>itinerary</M>, <M>roadmap</M>, <M>sheet</M>,{" "}
                <M>chart</M>, <M>folder</M>. Deleting a folder returns its children to the root
                instead of destroying them.
              </>
            ),
          },
          {
            name: "doc_write / doc_read",
            line: (
              <>
                Naming a tab that does not exist <B>creates it</B>; passing a note id rewrites in
                place instead of appending a second copy. The read is scoped server-side, so
                reading one tab never drags the rest of the canvas along.
              </>
            ),
          },
          {
            name: "Live markdown, no edit/read toggle",
            line: (
              <>
                An unfocused note renders; clicking in turns the same box into editable source at
                that caret. Remote pushes are adopted only while unfocused, so a collaborator's
                edit never yanks text out from under you.
              </>
            ),
          },
          {
            name: "One-call briefing",
            line: (
              <>
                <M>context_get</M> returns identity, the briefing doc, document tabs, per-kind
                counts and the approved queue — and with a task id, that one task hydrated with
                its linked notes and roadmap items.
              </>
            ),
          },
          {
            name: "Freshness is derived, never stored",
            line: (
              <>
                Only the verification timestamp is persisted; <M>fresh</M> / <M>aging</M> /{" "}
                <M>stale</M> / <M>unknown</M> is computed at read time, and{" "}
                <B>unknown is explicitly not the same as stale</B>.
              </>
            ),
          },
          {
            name: "Verified is not updated",
            line: (
              <>
                Vouching for content is a separate act from editing it — a body patch never
                re-certifies text nobody re-read.
              </>
            ),
          },
          {
            name: "Stale context is shown, never filtered",
            line: (
              <>
                A stale note stays in the bundle carrying a visible{" "}
                <M>[stale — verified 21d ago]</M> annotation. Hiding it would just make the agent
                confidently ignorant.
              </>
            ),
          },
          {
            name: "Review feedback comes back on the ticket",
            line: (
              <>
                One block derived at read time — outcome, reason verbatim, who and when — on{" "}
                <M>task_get</M>, on the epic rollup and in the context bundle.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "provenance",
    n: "06",
    title: "Provenance and receipts",
    lead: (
      <>
        When your collaborators are machines, "who wrote this" is the authorization boundary.
        Tandem answers it structurally rather than by asking.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Three authorship shapes",
            line: (
              <>
                <M>human</M> — unforgeable, requires a real signed session. <M>agent:&lt;id&gt;</M>{" "}
                — the identity is client-asserted but the <B>classification</B> is server-owned,
                so an agent can never emit a bare <M>human</M>. <M>anonymous</M> — a valid canvas
                token with neither.
              </>
            ),
          },
          {
            name: "Unknown is not backfilled",
            line: (
              <>
                Rows predating provenance render nothing at all, rather than being quietly
                assigned an author that was never recorded.
              </>
            ),
          },
          {
            name: "Completion evidence",
            line: (
              <>
                <M>task_complete</M> appends commit, PR and branch links — appended, never
                replaced, so the record of a reworked ticket keeps both attempts.
              </>
            ),
          },
          {
            name: "GitHub links resolve live",
            line: (
              <>
                Merged, open, draft, checks-ok, failing. Structurally read-only: the route is
                GET-only and every outbound URL is <B>constructed server-side</B> from a parsed
                owner/repo/ref, so the caller's URL is never dereferenced.
              </>
            ),
          },
          {
            name: "Unknown renders nothing",
            line: (
              <>
                When the status cannot be resolved the board shows no chip — absence of a claim,
                not a claim of absence.
              </>
            ),
          },
          {
            name: "Audit trail and progress log",
            line: (
              <>
                Content edits that cost an approval are kept distinct from human state moves and
                reviewer bounces; every heartbeat is an append-only entry rendered as a log on the
                ticket page.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "workspace",
    n: "07",
    title: "The web workspace",
    lead: (
      <>
        React, Vite and Tailwind, with hand-rolled history routing and no router library. The
        board's job is that one glance answers "what is waiting, what is claimed, what landed".
      </>
    ),
    groups: [
      {
        heading: "Board",
        features: [
          {
            name: "Five columns",
            line: (
              <>
                Proposed · Ready · Working · Done · Closed, where failed and rejected share the
                last lane.
              </>
            ),
          },
          {
            name: "Epics are a lens, not cards",
            line: (
              <>
                A left timeline with state chip, progress, drain time and inline approve/reject on
                proposed epics. Scope persists per canvas; aged-out epics collapse away.
              </>
            ),
          },
          {
            name: "No drag-and-drop for state",
            line: (
              <>
                On purpose: a state change is a <B>decision</B>, not a gesture, and has to be as
                available to a keyboard as to a mouse. Drag exists elsewhere — tabs, docs, roadmap
                and sheet reordering.
              </>
            ),
          },
          {
            name: "Bulk triage",
            line: (
              <>
                Shift-range, cmd-toggle, arrow stepping and a touch select mode, over an id set
                that survives live pushes. One shared reject reason, asked once, with an undo.
              </>
            ),
          },
          {
            name: "Search reaches past the current scope",
            line: (
              <>
                A ticket ref is an address that wins outright; otherwise the same ranked ladder
                the MCP <M>task_find</M> uses, with out-of-scope hits <B>reported</B> rather than
                silently omitted.
              </>
            ),
          },
          {
            name: "A proposed epic renders as a plan to review",
            line: (
              <>
                Plan digest, the plan's own ticket order, and per-ticket quality lines from the
                same implementation the gateway runs at propose time.
              </>
            ),
          },
          {
            name: "Card flight",
            line: (
              <>
                A moving card is cloned into a fixed ghost so the animation is not clipped at the
                column boundary it is crossing, then lands with a glow — and is skipped entirely
                under reduced motion.
              </>
            ),
          },
          {
            name: "Lease chips",
            line: (
              <>
                <M>live</M> / <M>slipping</M> / <M>stale</M>, keeping "last heard from" and
                "lapses at" as separate facts. Board and fleet derive one identical lease from one
                function.
              </>
            ),
          },
        ],
      },
      {
        heading: "Fleet, presence and realtime",
        features: [
          {
            name: "The fleet tree",
            line: (
              <>
                Roster and activity feed in one panel, nesting subagents under the orchestrator
                that spawned them. Agents holding a claim or recently online are shown; the rest
                fold behind a disclosure.
              </>
            ),
          },
          {
            name: "Vendor identity is read, never guessed",
            line: (
              <>
                From the declared model — claude, codex, openai, gemini, the raw string, a bare
                registered agent, or <M>external</M> for something holding work that never
                registered.
              </>
            ),
          },
          {
            name: "Follow an agent",
            line: (
              <>
                Per-canvas, device-local, works signed out. Moves are coalesced one at a time and
                buffered while you type — busy is drawn at focus, not at the keyboard.
              </>
            ),
          },
          {
            name: "Push, not poll",
            line: (
              <>
                One socket with version-gated state application, a bounded outbound queue and a
                reconnect budget. The connection chip is hidden while connected and is the only
                signal that a push-only board has gone stale.
              </>
            ),
          },
          {
            name: "Notifications that cannot be muted into silence",
            line: (
              <>
                Muting silences popups — never the log, never the badge.
              </>
            ),
          },
          {
            name: "A mock backend",
            line: <>The entire UI runs with no server at all, for design work and demos.</>,
          },
        ],
      },
      {
        heading: "Theming, mobile and other canvas modes",
        features: [
          {
            name: "Light / dark / system",
            line: (
              <>
                Tokens are RGB channels flipped by one class, so alpha utilities follow
                automatically. An inline boot script reads the preference before first paint, so
                there is no flash.
              </>
            ),
          },
          {
            name: "Mobile is additive, not a copy",
            line: (
              <>
                The drawer passes the <B>same</B> components as desktop and shares its view state,
                so the choice is continuous across breakpoints. Safe-area insets, a 48px touch
                target, and a reduced-motion opt-out on sheet animation.
              </>
            ),
          },
          {
            name: "Seven canvas modes",
            line: (
              <>
                <M>welcome</M>, <M>map</M>, <M>itinerary</M>, <M>docs</M>, <M>roadmap</M>,{" "}
                <M>sheets</M>, <M>charts</M> — nestable roadmap goals, Leaflet pins with travel
                polylines, timezone-aware itineraries, grid-paste sheets, and charts drawn as
                hand-rolled SVG with no charting library in the app.
              </>
            ),
          },
          {
            name: "Forms",
            line: (
              <>
                An authoring intent compiled against live canvas state and stored only if it
                validates, plus a scaffold that derives a draft form from an existing sheet.
                Submissions are idempotent by submission id.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "auth",
    n: "08",
    title: "Auth and access",
    lead: (
      <>
        The code is the view capability; the token is the own capability. Sharing a link can
        never leak ownership.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Canvas codes",
            line: (
              <>
                Eight characters over a 32-character ambiguity-free alphabet — no <M>0</M>/
                <M>O</M>, no <M>1</M>/<M>I</M>/<M>L</M> — from a cryptographic source.
              </>
            ),
          },
          {
            name: "Visibility and access",
            line: (
              <>
                Public or private, with a public role and per-user grants. Role changes apply live
                over the socket without a reconnect, and a revoked viewer's socket is closed.
              </>
            ),
          },
          {
            name: "Claim tokens",
            line: (
              <>
                Single-use, surfaced only once at creation. Claiming is one atomic update
                predicated on the canvas being unowned, so the first claimer wins.
              </>
            ),
          },
          {
            name: "Sign-in is optional",
            line: (
              <>
                Google OAuth, validated against Google's rotating keys. An empty client id
                disables it and the header degrades cleanly — anonymous public canvases stay
                seamless.
              </>
            ),
          },
          {
            name: "Personal access tokens",
            line: (
              <>
                Only the hash is stored and the plaintext is shown exactly once. Least-privilege
                by construction: the role is still resolved per canvas.
              </>
            ),
          },
          {
            name: "A full OAuth 2.1 authorization server",
            line: (
              <>
                Metadata discovery, dynamic client registration, PKCE, authorization code with
                refresh rotation, resource indicators — with a consent screen and a revoke-app
                list in account settings.
              </>
            ),
          },
          {
            name: "The session handle",
            line: (
              <>
                Hosted connectors drop their transport session across idle gaps.{" "}
                <M>canvas_connect</M> returns a handle the model carries back on every later
                call, so the binding survives a reset without a reconnect.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "mcp",
    n: "09",
    title: "The MCP surface",
    lead: (
      <>
        Published as <M>@jaximus/tandem-mcp</M>, with a stdio CLI and a hosted Streamable-HTTP
        endpoint. The default manifest is an 18-tool intent facade, because a CRUD manifest costs
        a large slice of the context window it is supposed to be helping.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "Eighteen tools, advertised by default",
            line: (
              <>
                <M>canvas_connect</M> <M>canvas_create</M> <M>agent_register</M>{" "}
                <M>context_get</M> <M>queue_next</M> <M>queue_wait</M> <M>task_find</M>{" "}
                <M>task_get</M> <M>task_claim</M> <M>task_progress</M> <M>task_complete</M>{" "}
                <M>task_propose</M> <M>task_amend</M> <M>task_review</M> <M>epic_propose</M>{" "}
                <M>doc_write</M> <M>doc_read</M> <M>board_status</M>
              </>
            ),
          },
          {
            name: "The CRUD surface is still there",
            line: (
              <>
                Eighty-odd tools covering maps, pins, events, notes, roadmap items, sheets, rows,
                charts, forms and documents — each with a batch variant — callable always, but
                advertised only behind an explicit opt-in. When opted in the manifest is additive,
                facade first.
              </>
            ),
          },
          {
            name: "Instructions ship with the manifest",
            line: (
              <>
                The executor loop, the approval gate, the peer exception and the orchestrator rule
                are served with the tool list, so a client reads them before its first call.
              </>
            ),
          },
          {
            name: "A pinned canvas rewrites the tool description",
            line: (
              <>
                <M>tandem-mcp init</M> writes the code into a project-scoped config, and the
                manifest then names <em>this project's</em> canvas — the model reads the manifest,
                not the process environment.
              </>
            ),
          },
          {
            name: "Zero to connected in one command",
            line: (
              <>
                <M>tandem-mcp init</M> creates the canvas, merges (never clobbers) your MCP
                config, prints the code and board URL, and can append an AGENTS.md snippet
                teaching the queue-first workflow. Re-running is a no-op.
              </>
            ),
          },
          {
            name: "Per-call tracing",
            line: (
              <>
                <M>MCP_TRACE</M> reports duration, the API time inside it, and ok/error — so a
                slow tool call is attributable rather than merely slow.
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: "ops",
    n: "10",
    title: "Operations",
    lead: (
      <>
        What it takes to run the thing and know whether it is healthy — including the parts that
        are deliberately small.
      </>
    ),
    groups: [
      {
        features: [
          {
            name: "In-memory metrics",
            line: (
              <>
                A bounded ring over a five-minute window, keyed by <B>route patterns</B> and never
                by concrete ids, with every counter a process-wide scalar — which is exactly why
                the endpoint can be open.
              </>
            ),
          },
          {
            name: "Persisted history",
            line: (
              <>
                A collector scrapes the registry on a timer into snapshots with a retention
                window. There is deliberately no canvas id on that table.
              </>
            ),
          },
          {
            name: "An operator console",
            line: (
              <>
                Latency, fan-out, throughput, contention and connected clients as hand-rolled SVG
                charts, with CSV/JSON export. Counters render as rates and delta series are{" "}
                <B>split at restart boundaries</B>, since every counter is cumulative since boot.
              </>
            ),
          },
          {
            name: "Access is an env allowlist",
            line: (
              <>
                Unset, the whole subtree 404s. Deliberately not a database role — Tandem has no
                admin model and is not getting one by accident.
              </>
            ),
          },
          {
            name: "A load-test harness",
            line: (
              <>
                Agent-concurrency scenarios asserting claim and queue latency, publishing
                baselines. Aborted and skipped runs are <B>stored, not dropped</B> — "the
                256-agent point could not complete" is itself the finding.
              </>
            ),
          },
          {
            name: "Exports and copies",
            line: (
              <>
                Sheet export and a calendar-subscribable itinerary feed that still enforces
                private-canvas visibility, plus an atomic deep-copy that regenerates ids while
                preserving sheet column ids so chart references stay valid.
              </>
            ),
          },
          {
            name: "Migrations are hand-written and applied by a person",
            line: (
              <>
                Numbered SQL, written to be re-runnable. Nothing in CI applies them — a schema
                change is a decision someone makes on purpose.
              </>
            ),
          },
        ],
      },
    ],
  },
];

/* ── The honest edges ────────────────────────────────────────────────────────
   Kept as its own section rather than dissolved into the pillars, so it cannot
   be skimmed past. Same rule as the doc: where a guarantee is really a
   convention, say so. */
const LIMITS: Feature[] = [
  {
    name: "The fence needs an asserted identity",
    line: (
      <>
        It engages only when a caller presents a claim identity. A browser and an agent carry
        identical canvas tokens, so the human board keeps its escape hatch <B>on purpose</B> — and
        a blank or generic holder is not an exclusive identity and blocks nobody.
      </>
    ),
  },
  {
    name: "The reviewer's model is self-asserted",
    line: (
      <>
        Cross-model review raises the cost of <em>accidental</em> same-model review. It cannot
        stop a client that misreports, and comparison fails <B>open</B> when a model is
        unrecorded — the deliberate opposite posture from the identity checks, so an unknown model
        cannot brick review on a live canvas.
      </>
    ),
  },
  {
    name: "The web mirrors the lease TTL as a constant",
    line: (
      <>
        Override it in a deployment and the board reads early or late. The ordering of
        live/slipping/stale stays right.
      </>
    ),
  },
  {
    name: "Two webhook events have no explanatory label",
    line: (
      <>
        <M>task.returned</M> and <M>task.rejected</M> render in the config modal with no sentence
        under them, and existing webhook configs were never backfilled onto them — an older
        webhook has to tick the new boxes.
      </>
    ),
  },
  {
    name: "Out-of-band work is invisible to all of this",
    line: (
      <>
        Nothing about a claim stops an agent doing work without claiming it — which is how the
        same feature once got implemented twice in one afternoon. The rule that incident left
        behind: if the work is happening, the board must say so before it starts.
      </>
    ),
  },
];

/** One name → one line row. The whole page is made of these. */
function FeatureRow({ f }: { f: Feature }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-8">
      <dt className="text-[15px] font-medium leading-snug tracking-tight text-ink">{f.name}</dt>
      <dd className="text-[15px] leading-relaxed text-ink/65">{f.line}</dd>
    </div>
  );
}

export default function Features({
  onBack,
  onOpenMCP,
  onShowCanvases,
  onShowSettings,
  onOpenCanvas,
  onAbout,
  onWhy,
}: Props) {
  // The nav's About link is required; without a router handler fall back to a
  // real navigation so the link still goes somewhere.
  const goAbout = onAbout ?? (() => window.location.assign("/about"));

  return (
    <div className="min-h-screen bg-paper font-sans text-ink [text-rendering:optimizeLegibility] antialiased">
      <LandingNav
        onHome={onBack}
        onJoin={onOpenCanvas}
        onOpenMCP={onOpenMCP}
        onShowCanvases={onShowCanvases}
        onShowSettings={onShowSettings}
        onAbout={goAbout}
        onWhy={onWhy}
        onFeatures={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      />

      {/* ── Title and the section index ──────────────────────────────────────── */}
      <header className="border-b border-ink/10">
        <div className="tandem-rise mx-auto max-w-4xl px-6 pb-12 pt-16 sm:pt-20">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">Reference</span>
          <h1 className="mt-4 text-[2rem] font-semibold leading-[1.1] tracking-tight text-ink sm:text-[2.5rem]">
            What Tandem can do
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink/65">
            The capability inventory — everything Tandem actually does, by pillar. Nothing here is
            planned, in progress or nearly done: each line was read out of the code, and honest
            limits get their own section rather than being quietly rounded up.
          </p>

          <nav aria-label="Sections" className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink/10 bg-ink/10 sm:grid-cols-3 lg:grid-cols-4">
            {PILLARS.map((p) => (
              <a
                key={p.id}
                href={`#${p.id}`}
                className="group bg-paper px-4 py-3 transition-colors hover:bg-surface"
              >
                <span className="font-code text-[11px] text-ink/35">{p.n}</span>
                <span className="mt-0.5 block text-[13px] font-medium leading-snug tracking-tight text-ink/75 transition-colors group-hover:text-ink">
                  {p.title}
                </span>
              </a>
            ))}
            <a
              href="#limits"
              className="group bg-paper px-4 py-3 transition-colors hover:bg-surface"
            >
              <span className="font-code text-[11px] text-ink/35">—</span>
              <span className="mt-0.5 block text-[13px] font-medium leading-snug tracking-tight text-ink/75 transition-colors group-hover:text-ink">
                Honest limits
              </span>
            </a>
          </nav>
        </div>
      </header>

      {/* ── The pillars ──────────────────────────────────────────────────────────
          Alternating paper / surface bands, exactly the rhythm WhyTandem uses. */}
      {PILLARS.map((p, i) => (
        <section
          key={p.id}
          id={p.id}
          className={
            i % 2 === 1 ? "border-b border-ink/10 bg-surface scroll-mt-14" : "border-b border-ink/10 scroll-mt-14"
          }
        >
          <div className="mx-auto max-w-4xl px-6 py-14 sm:py-16">
            <div className="flex items-baseline gap-3">
              <span className="font-code text-sm text-ink/35 tabular-nums">{p.n}</span>
              <h2 className="text-2xl font-semibold leading-tight tracking-tight text-ink">
                {p.title}
              </h2>
            </div>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink/60">{p.lead}</p>

            {p.groups.map((g, gi) => (
              <div key={g.heading ?? gi} className="mt-8">
                {g.heading && (
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/45">
                    {g.heading}
                  </h3>
                )}
                <dl className="divide-y divide-ink/10 border-t border-ink/10">
                  {g.features.map((f) => (
                    <FeatureRow key={f.name} f={f} />
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* ── Honest limits ────────────────────────────────────────────────────── */}
      <section id="limits" className="scroll-mt-14">
        <div className="mx-auto max-w-4xl px-6 py-14 sm:py-16">
          <div className="flex items-baseline gap-3">
            <span className="font-code text-sm text-ink/35">—</span>
            <h2 className="text-2xl font-semibold leading-tight tracking-tight text-ink">
              Honest limits
            </h2>
          </div>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink/60">
            Where a guarantee is really a convention, or a check fails open. Recorded here rather
            than rounded up, because a capability list is only useful if it is also accurate about
            its edges.
          </p>

          <dl className="mt-8 divide-y divide-ink/10 border-t border-ink/10">
            {LIMITS.map((f) => (
              <FeatureRow key={f.name} f={f} />
            ))}
          </dl>
        </div>
      </section>

      {/* Footer — the same shape as WhyTandem's. */}
      <footer className="border-t border-ink/10 bg-surface">
        <div className="mx-auto flex max-w-4xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-ink/45 sm:flex-row">
          <div className="flex items-center gap-2">
            <TandemLogo size={18} animate={false} />
            <span>Tandem — you and your agents, in tandem.</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="/why-tandem"
              onClick={onWhy ? spaLink(onWhy) : undefined}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              Why Tandem
            </a>
            <a
              href="/about"
              onClick={onAbout ? spaLink(onAbout) : undefined}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              About
            </a>
            <p>
              made by{" "}
              <a
                href={WEBSITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-ink"
              >
                Jaxon
              </a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
