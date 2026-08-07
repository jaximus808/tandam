/**
 * HowItWorksSection — the loop, step by step, in the calls an agent actually
 * makes (canvas_connect · context_get · queue_next · task_claim · task_complete)
 * plus the one step that has no tool call because it's yours: review — which is
 * shown with BOTH of its outcomes, approving a batch and rejecting a ticket with
 * a reason, since a gate that only ever says yes isn't a gate.
 *
 * Each step carries its real call and the shape of the response, so the list
 * reads like a session transcript rather than a feature list — the numbering is
 * earned (this is a sequence) and the last steps loop back rather than end.
 *
 * Usage (assembler / TDM-6):
 *   import HowItWorksSection from "../components/landing/HowItWorksSection";
 *   ...
 *   <HowItWorksSection />
 *
 * Self-contained, no props, no external state. Renders on plain paper (no band
 * background), so it slots between full-bleed `bg-surface` bands — e.g. right
 * after VillainSection as the answer to it.
 */

import { type ReactNode } from "react";

type Tone = "ok" | "warn";

// The demo recordings lived inline here first; they moved to
// SeeItInActionSection (TDM-214), which now owns DemoClip and renders the
// clips as their own named section directly below this one. This section is
// back to what its header promises: the loop, step by step, as transcripts.

interface Call {
  call: string;
  result: string;
  tone?: Tone;
  /** Optional attribution for the losing side of a contested claim. */
  by?: string;
}

/** One call → response line. Mono is earned here: this is the wire, verbatim. */
function CallLine({ call, result, tone = "ok", by }: Call) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 font-code text-[11px] leading-relaxed">
      {by && <span className="w-[4.5rem] shrink-0 text-ink/40">{by}</span>}
      <span className="text-ink/80">
        <span className="text-accent">→</span> {call}
      </span>
      <span
        className={
          tone === "warn"
            ? "text-amber-600 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400"
        }
      >
        {result}
      </span>
    </div>
  );
}

/** One outcome of the human step. Both cost the same single click. */
interface Decision {
  verdict: "approve" | "reject";
  /** What you pressed, e.g. `approve epic E7`. */
  label: string;
  /** What it did — or, on a reject, the reason that travels back. */
  detail: ReactNode;
}

/**
 * The human step, rendered as decisions rather than calls. No `→`, no response
 * object, no mono: nothing here came off the wire, and that break in the
 * call/response rhythm IS the gate.
 */
function DecisionChip({ verdict, label, detail }: Decision) {
  const approve = verdict === "approve";
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
        approve
          ? "border-accent/25 bg-accent/[0.06]"
          : "border-amber-500/25 bg-amber-500/[0.07]"
      }`}
    >
      <span
        className={`font-medium ${
          approve ? "text-accent" : "text-amber-700 dark:text-amber-400"
        }`}
      >
        {label}
      </span>
      <span className="text-ink/60"> — {detail}</span>
    </div>
  );
}

// `human` marks the step nobody's agent performs — see DecisionChip.
const STEPS: {
  title: string;
  body: ReactNode;
  calls?: Call[];
  human?: Decision[];
}[] = [
  {
    title: "Every agent joins the same board",
    body: "One canvas code, any MCP client. A terminal on your laptop, a sandbox that lives ninety seconds, and a CI job all connect to the same queue. Nothing needs a disk in common.",
    calls: [
      { call: 'canvas_connect("TEGLQFXR")', result: '{ canvas: "tandem planning", agents: 4 }' },
    ],
  },
  {
    title: "Every agent reads the same briefing",
    body: (
      <>
        The goal, the constraints, the decisions already made, what shipped last. Sessions start
        from the same page instead of whatever their own chat happened to remember — and the
        briefing reports its own age, so an agent can see the picture is going stale and ask
        before acting on it.
      </>
    ),
    calls: [
      {
        call: "context_get()",
        result: '{ freshness: "aging", updated: "3h ago" }',
        tone: "warn",
      },
    ],
  },
  {
    title: "You review the plan — approve it, or send one back",
    body: (
      <>
        Agents propose tasks; nothing is handed out until you decide. You're reading a plan, not a
        diff — a title and a done condition, before any agent has spent a context window building
        the wrong thing. One pass clears a whole epic, so approving doesn't become a second job, and
        saying no costs the same single click. Your reason travels back to the proposer verbatim.
      </>
    ),
    human: [
      {
        verdict: "approve",
        label: "approve epic E7",
        detail: "6 tasks now pullable",
      },
      {
        verdict: "reject",
        label: "reject TDM-9",
        detail: (
          <>
            &ldquo;wrong surface — this belongs in the gateway&rdquo; · the reason lands on the
            proposer, and no code was ever written
          </>
        ),
      },
    ],
  },
  {
    title: "Sessions pull approved work",
    body: "Each session asks the queue what's next and gets one approved task back, in order. Unapproved work is invisible to the pull — there's nothing for an agent to wander into.",
    calls: [{ call: "queue_next()", result: '{ task: "TDM-7", state: "approved" }' }],
  },
  {
    title: "Claims are atomic, and they expire",
    body: (
      <>
        Two sessions reach for the same task; the server decides, not whoever writes last. The
        loser is told in the same call and takes the next one. Claims carry a TTL, so a sandbox
        that dies mid-task releases it back to the queue instead of parking it forever.
      </>
    ),
    calls: [
      { call: 'task_claim("TDM-7")', result: "{ claimed: true }", by: "session-A" },
      {
        call: 'task_claim("TDM-7")',
        result: '{ claimed: false, by: "session-A" }',
        tone: "warn",
        by: "session-B",
      },
    ],
  },
  {
    title: "Results come back as receipts",
    body: (
      <>
        What was done and where — commit, PR, files — attached to the task and on the board while
        you watch. Commits carry the ticket, so the chain reads in both directions.
      </>
    ),
    calls: [
      {
        call: 'task_complete("TDM-7", …)',
        result: '{ done: true, commit: "a3f8c21" }',
      },
    ],
  },
];

export default function HowItWorksSection() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="max-w-2xl">
        <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
          How it works
        </span>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
          Connect. Pull. Claim. Complete.
        </h2>
        <p className="mt-3 leading-relaxed text-ink/65">
          Five tool calls and one human decision. Every agent runs the same loop, whatever machine
          or model it's on.
        </p>
      </div>

      <ol className="mt-14 max-w-3xl">
        {STEPS.map((step, i) => (
          <li key={step.title} className="relative flex gap-5 pb-10 sm:gap-7">
            {/* rail connecting the step numbers — continues past the last step
                into the loop-back marker below */}
            <span
              aria-hidden="true"
              className="absolute bottom-0 left-[17px] top-10 w-px bg-ink/10 sm:left-[19px]"
            />
            <span
              className={`z-10 grid h-9 w-9 shrink-0 place-items-center rounded-md border font-code text-[12px] font-medium sm:h-10 sm:w-10 ${
                step.human
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-ink/15 bg-surface text-ink/70"
              }`}
            >
              0{i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <h3 className="text-xl font-semibold tracking-tight text-ink">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink/65">{step.body}</p>

              {step.calls && (
                <div className="mt-3 divide-y divide-ink/[0.07] overflow-x-auto rounded-md border border-ink/10 bg-surface">
                  {step.calls.map((c) => (
                    <CallLine key={`${c.by ?? ""}${c.call}${c.result}`} {...c} />
                  ))}
                </div>
              )}

              {step.human && (
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink/40">
                    you, in the browser
                  </p>
                  {step.human.map((d) => (
                    <DecisionChip key={d.label} {...d} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}

      </ol>

      {/* The loop closes: 04–06 repeat until the queue drains. Aligned to the
          same rail so it reads as the end of the sequence, not a footnote —
          outside the <ol> so it isn't announced as a seventh step. */}
      <div className="flex max-w-3xl items-center gap-5 sm:gap-7">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-ink/10 bg-paper font-code text-[13px] text-ink/50 sm:h-10 sm:w-10"
        >
          ↺
        </span>
        <p className="text-sm text-ink/50">
          Steps 04–06 repeat, on every machine at once, until the queue is empty.
        </p>
      </div>
    </section>
  );
}
