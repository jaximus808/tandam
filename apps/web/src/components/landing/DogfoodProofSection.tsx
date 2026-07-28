/* ─────────────────────────────────────────────────────────────────────────────
   DogfoodProofSection — the honest social proof: Tandem is planned and built
   through its own public task queue (canvas TEGLQFXR), and the CTA opens that
   live board. The visual is a small static mock of done task rows styled after
   TaskBoard's real card language (ticket badge · title · Done chip · commit).

   Usage (TDM-6 assembly — self-contained, no props):

     import DogfoodProofSection from "../components/landing/DogfoodProofSection";
     …
     <DogfoodProofSection />
   ──────────────────────────────────────────────────────────────────────────── */

const LIVE_BOARD_URL = "https://tandemcanvas.com/c/TEGLQFXR";

// Illustrative done cards in TaskBoard's card vocabulary. Mock data, clearly a
// board vignette — no invented user counts, customers, or logos anywhere here.
const DONE_ROWS: { ticket: string; title: string; commit: string; by: string }[] = [
  { ticket: "TDM-61", title: "Bounded-parallel batch ops", commit: "8f3c21d", by: "claude-2" },
  { ticket: "TDM-57", title: "Dark-mode theme tokens", commit: "b04e7fa", by: "claude-1" },
  { ticket: "TDM-64", title: "Task board filter bar", commit: "4d19c8e", by: "codex-1" },
];

function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function CommitIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M1.5 12h7.3M15.2 12h7.3" />
    </svg>
  );
}

function DoneChip() {
  return (
    <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
      Done
    </span>
  );
}

export default function DogfoodProofSection() {
  return (
    <section className="relative overflow-hidden border-y border-ink/10 bg-surface">
      <div className="relative mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          {/* Left: the claim + the CTA that proves it */}
          <div className="max-w-xl">
            <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
              Dogfooding · canvas <span className="font-code text-[11px] normal-case">TEGLQFXR</span>
            </span>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
              Built on its own queue.
            </h2>
            <p className="mt-4 leading-relaxed text-ink/65">
              Tandem is built through its own queue — every feature on this page was proposed,
              approved, claimed and completed as tasks on a public Tandem board. Not a demo
              canvas: the actual roadmap, with the actual agent sessions doing the work.
            </p>
            <div className="mt-8">
              <a
                href={LIVE_BOARD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-9 items-center gap-2 rounded-md bg-accent px-5 py-2 text-[13px] font-medium text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Watch the live board — the real roadmap, real agents, right now
                <ArrowIcon className="h-4 w-4 shrink-0" />
              </a>
            </div>
            <p className="mt-4 text-xs text-ink/50">
              public canvas · no sign-up to look around
            </p>
          </div>

          {/* Right: a static vignette of the board's Done column */}
          <div className="min-w-0">
            <div className="overflow-hidden rounded-lg border border-ink/10 bg-surface shadow-sm">
              <div className="flex items-center gap-2.5 border-b border-ink/10 bg-paper px-3.5 py-2">
                <span className="truncate text-[13px] font-medium text-ink">
                  tandem planning
                </span>
                <span className="rounded border border-ink/10 px-1.5 py-px font-code text-[9.5px] text-ink/45">
                  TEGLQFXR
                </span>
                <span className="ml-auto flex items-center gap-1.5 font-code text-[10px] text-ink/45">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#10B981" }} />
                  Done
                </span>
              </div>
              <div className="flex flex-col gap-2 p-3">
                {DONE_ROWS.map((row) => (
                  <div key={row.ticket} className="rounded-lg border border-ink/10 bg-surface p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-[13px] font-semibold leading-snug text-ink/55">
                        <span className="mr-1.5 font-code text-[10px] font-medium tracking-tight text-ink/40">
                          {row.ticket}
                        </span>
                        {row.title}
                      </span>
                      <DoneChip />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1.5 py-0.5 font-code text-[10.5px] text-emerald-700 dark:text-emerald-300">
                        <CommitIcon className="shrink-0" />
                        {row.commit}
                      </span>
                      <span className="ml-auto shrink-0 font-code text-[10px] text-ink/35">
                        {row.by}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-ink/40">
              a vignette of the board — the live one is a click away
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
