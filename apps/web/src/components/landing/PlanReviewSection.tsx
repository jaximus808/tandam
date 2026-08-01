/* ─────────────────────────────────────────────────────────────────────────────
   PlanReviewSection — the GATE's own beat: "Review the plan, not the pile of
   diffs." The one thing Tandem moves is *when* you find out an agent was wrong:
   from after the code to before it exists. So this section shows the plan gate
   as a mechanism, not as a promise — a vague prompt becomes a proposed epic of
   tickets, you triage the plan (approve / reject / amend, all inline), and a
   rejection's reason travels back to the proposing agent on its next task_get
   (the `review` block, TDM-161).

   The vignette is a static mock in the REAL board's vocabulary — the state
   chips come from lib/stateChips (proposed amber · ready sky · rejected zinc)
   and the triage row echoes TaskBoard's TriageControls (accent Approve, rose
   Reject, pencil Amend). Nothing here is UI the product doesn't have.

   Motion budget: none. The section is below the fold and every element is
   static, so a mount-time entrance would fire unseen.

   Usage (self-contained, no props):

     import PlanReviewSection from "../components/landing/PlanReviewSection";
     …
     <PlanReviewSection />

   Renders on plain paper with a top hairline, so it separates cleanly from the
   paper section above it and from the `bg-surface` band below.
   ──────────────────────────────────────────────────────────────────────────── */

import type { ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import { CHIP_BASE, STATE_CHIP } from "../../lib/stateChips";

/** Monospace chip for a real MCP tool name (machine text — mono is earned). */
function ToolChip({ name }: { name: string }) {
  return (
    <span className="rounded border border-ink/10 bg-surface px-1.5 py-0.5 font-code text-[10.5px] font-medium text-ink/70">
      {name}
    </span>
  );
}

/** A state chip in the shared six-hue semantic palette (lib/stateChips). */
function StateChip({ state }: { state: keyof typeof STATE_CHIP | string }) {
  const chip = STATE_CHIP[state] ?? STATE_CHIP.proposed;
  return <span className={`${CHIP_BASE} ${chip.chip}`}>{chip.label}</span>;
}

/* The three beats of the gate, in the order a person meets them. Mechanism
   first: each one names what the server does, not how it feels. */
const BEATS: { heading: string; body: ReactNode; tools?: string[] }[] = [
  {
    heading: "A vague ask becomes a plan you can read",
    body: (
      <>
        "Fix auth, the email service, and messaging" names three areas and zero
        surfaces. The agent proposes it as an epic of named tickets instead —
        each with the surface it touches and a done condition someone else could
        check. Nothing in it is claimable yet.
      </>
    ),
    tools: ["epic_propose"],
  },
  {
    heading: "You triage the plan, not the diffs",
    body: (
      <>
        Approve, reject or amend, inline on the row. Rejecting costs exactly what
        approving costs — one tap, with an undo — because a gate whose cheap
        button is "yes" isn't a gate. Amend is the third verb: right idea, wrong
        scope, fixed in place without letting it run.
      </>
    ),
  },
  {
    heading: "The reason travels back to the agent",
    body: (
      <>
        A rejected ticket isn't a dropped one. Your reason is stored verbatim and
        comes back to the proposing agent in its next{" "}
        <span className="font-code text-[13px] text-ink/70">task_get</span> as a{" "}
        <span className="font-code text-[13px] text-ink/70">review</span> block —
        so it corrects the plan instead of guessing why the count dropped.
      </>
    ),
    tools: ["task_get", "task_amend"],
  },
];

/* The triage vignette's rows. Illustrative tickets in the board's own card
   language — a batch mid-triage: two cleared, one rejected with the reason
   showing, one still holding the three verbs. */
type Row = {
  ticket: string;
  title: string;
  state: "approved" | "rejected" | "proposed";
  reason?: string;
};

const ROWS: Row[] = [
  { ticket: "TDM-207", title: "Rotate refresh tokens on reuse", state: "approved" },
  { ticket: "TDM-208", title: "Retry the email queue with backoff", state: "approved" },
  {
    ticket: "TDM-209",
    title: "Rewrite messaging storage",
    state: "rejected",
    reason: "Out of scope — messaging stays on the current schema this cycle.",
  },
  { ticket: "TDM-210", title: "Unify session expiry across surfaces", state: "proposed" },
];

/** One card in the vignette, in TaskBoard's proposed-card geometry. */
function TriageRow({ row }: { row: Row }) {
  const dimmed = row.state === "rejected";
  return (
    <div
      className={`rounded-lg border border-ink/10 bg-surface p-2.5 ${dimmed ? "opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`min-w-0 text-[13px] font-semibold leading-snug ${
            dimmed ? "text-ink/45 line-through decoration-ink/20" : "text-ink/80"
          }`}
        >
          <span className="mr-1.5 font-code text-[10px] font-medium tracking-tight text-ink/40">
            {row.ticket}
          </span>
          {row.title}
        </span>
        <StateChip state={row.state} />
      </div>

      {/* A rejection carries its reason — that text is the whole payload the
          proposing agent reads back. */}
      {row.reason && (
        <p className="mt-1.5 border-l-2 border-ink/15 pl-2 text-[11.5px] leading-relaxed text-ink/50">
          {row.reason}
        </p>
      )}

      {/* The three verbs, on one row — TaskBoard's TriageControls, static. */}
      {row.state === "proposed" && (
        <div className="mt-2 flex gap-1.5" aria-hidden="true">
          <span className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white">
            <Check size={12} /> Approve
          </span>
          <span className="flex flex-1 items-center justify-center gap-1 rounded-md border border-rose-500/30 px-2 py-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
            <X size={12} /> Reject
          </span>
          <span className="flex shrink-0 items-center justify-center rounded-md border border-ink/15 px-2 py-1 text-ink/55">
            <Pencil size={12} />
          </span>
        </div>
      )}
    </div>
  );
}

export default function PlanReviewSection() {
  return (
    <section className="border-t border-ink/10">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            The approval gate
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
            Review the plan, not the pile of diffs.
          </h2>
          <p className="mt-3 leading-relaxed text-ink/65">
            An agent's plan is a list of titles you can read in a minute. The code
            that plan produces is an afternoon. Tandem moves the moment you find
            out an agent was wrong from after the diff to before it exists.
          </p>
        </div>

        <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
          {/* Left: the mechanism, beat by beat */}
          <ol className="min-w-0">
            {BEATS.map((beat, i) => (
              <li
                key={beat.heading}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 border-t border-ink/10 py-6 first:border-t-0 first:pt-0"
              >
                <span className="mt-0.5 font-code text-[11px] font-medium text-ink/35">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold tracking-tight text-ink">
                    {beat.heading}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink/65">{beat.body}</p>
                  {beat.tools && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {beat.tools.map((t) => (
                        <ToolChip key={t} name={t} />
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {/* Right: the board mid-triage, then what the agent reads back */}
          <div className="min-w-0">
            <div className="overflow-hidden rounded-lg border border-ink/10 bg-surface shadow-sm">
              <div className="flex items-center gap-2.5 border-b border-ink/10 bg-paper px-3.5 py-2">
                <span className="truncate text-[13px] font-medium text-ink">
                  Epic · Fix auth, email, messaging
                </span>
                <span className="ml-auto shrink-0">
                  <StateChip state="proposed" />
                </span>
              </div>
              <div className="flex flex-col gap-2 p-3">
                {ROWS.map((row) => (
                  <TriageRow key={row.ticket} row={row} />
                ))}
              </div>
            </div>

            {/* The rejection's reason, as the proposing agent receives it. */}
            <div className="mt-3 overflow-x-auto rounded-lg border border-ink/10 bg-surface px-3.5 py-3">
              <pre className="font-code text-[11px] leading-relaxed text-ink/60">
                <span className="text-ink/40">{"// what the proposing agent reads next\n"}</span>
                {`task_get TDM-209 → review: {
  outcome: "rejected",
  reason:  "Out of scope — messaging stays on
            the current schema this cycle."
}`}
              </pre>
            </div>

            <p className="mt-3 text-center text-[11px] text-ink/40">
              a vignette of the board mid-triage — approve, reject, amend, in place
            </p>
          </div>
        </div>

        <p className="mt-12 max-w-2xl text-sm leading-relaxed text-ink/55">
          Every decision keeps its provenance: who proposed the ticket, who
          approved it, and under which gate — human, reviewing agent, or policy.
          Three weeks later, "who let this in" is a question the board can answer.
        </p>
      </div>
    </section>
  );
}
