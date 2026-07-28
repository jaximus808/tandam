/**
 * HowItWorksSection — the five-step loop, mirroring the README's "How it works"
 * list one-for-one (real MCP tool names, verified against
 * apps/mcp-gateway/src/tools.ts — no invented tools).
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

import type { ReactNode } from "react";

/** Monospace chip for a real MCP tool name. */
function ToolChip({ name }: { name: string }) {
  return (
    <span className="rounded-[3px] border border-ink/10 bg-surface px-1.5 py-0.5 font-code text-[10.5px] font-medium text-agent">
      {name}
    </span>
  );
}

const STEPS: { title: string; body: ReactNode; tools?: string[] }[] = [
  {
    title: "The spec lives in your repo",
    body: "Like it always has. Intent stays in git — the spec, the code, the history. Tandem only ever holds the churn.",
  },
  {
    title: "An agent proposes the work",
    body: (
      <>
        One session decomposes the spec into an epic and its tasks. They land as{" "}
        <em className="not-italic font-medium text-ink/80">proposed</em> — nothing runs yet.
      </>
    ),
    tools: ["canvas_epic_add", "canvas_task_add"],
  },
  {
    title: "You approve once",
    body: "One click in the web UI approves the epic and every task under it. That's the whole ceremony — no per-step pinging after that.",
  },
  {
    title: "N sessions claim without colliding",
    body: (
      <>
        Claude Code, Cursor, any MCP client — each pulls the approved queue and claims a task.
        Claims are atomic: the loser gets{" "}
        <span className="font-code text-[13px] text-ink/70">already claimed</span> and takes the
        next task.
      </>
    ),
    tools: ["canvas_task_start"],
  },
  {
    title: "Results link back to commits",
    body: (
      <>
        Each finished task reports what was done and where — commit, PR, files — while you watch
        the board move. Commits carry the ticket, e.g.{" "}
        <span className="font-code text-[13px] text-ink/70">TDM-7: add rate limiter</span>.
      </>
    ),
    tools: ["canvas_task_complete"],
  },
];

export default function HowItWorksSection() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="max-w-2xl">
        <span className="font-code text-[11px] uppercase tracking-[0.22em] text-ink/40">
          The loop
        </span>
        <h2 className="mt-3 font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
          Spec in git. Queue in Tandem.
        </h2>
        <p className="mt-3 leading-relaxed text-ink/65">
          Five steps, one human approval. Everything else is sessions claiming from the same
          durable queue.
        </p>
      </div>

      <ol className="mt-14 max-w-3xl">
        {STEPS.map((step, i) => (
          <li key={step.title} className="relative flex gap-5 pb-10 last:pb-0 sm:gap-7">
            {/* rail connecting the step numbers */}
            {i < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-[17px] top-10 w-px bg-ink/10 sm:left-[19px]"
              />
            )}
            <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-md border-[1.5px] border-ink bg-surface font-code text-[12px] font-medium text-ink shadow-[3px_3px_0_rgba(28,25,23,0.12)] sm:h-10 sm:w-10">
              0{i + 1}
            </span>
            <div className="min-w-0 pt-1">
              <h3 className="font-display text-xl font-medium text-ink">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink/65">{step.body}</p>
              {step.tools && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {step.tools.map((t) => (
                    <ToolChip key={t} name={t} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
