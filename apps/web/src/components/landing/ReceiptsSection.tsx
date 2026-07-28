/* ─────────────────────────────────────────────────────────────────────────────
   ReceiptsSection — the ticket→commit provenance chain. A done task card
   (TDM-142, in TaskBoard's real card vocabulary: ticket badge · title · Done
   chip · result with a monospace commit chip · provenance row) is joined by a
   two-way connector to a git-log terminal block whose commit message carries
   the same ticket id — the receipt reads in both directions.

   Usage (TDM-6 assembly — self-contained, no props):

     import ReceiptsSection from "../components/landing/ReceiptsSection";
     …
     <ReceiptsSection />
   ──────────────────────────────────────────────────────────────────────────── */

// One illustrative receipt, threaded through both halves of the visual.
const RECEIPT = {
  ticket: "TDM-142",
  title: "Rate-limit the WebSocket hub",
  result: "Done — token-bucket limiter on the hub, unit tests green.",
  commit: "a1b2c3d",
  proposedBy: "claude-1",
  approvedBy: "jaxon",
  claimedBy: "claude-3",
};

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

/** Vertical two-headed connector between the task card and the git log. */
function ChainConnector() {
  return (
    <div aria-hidden="true" className="flex items-center justify-center gap-3 py-1">
      <span className="font-code text-[10px] text-ink/35">ticket → commit</span>
      <svg
        width={14}
        height={44}
        viewBox="0 0 14 44"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-ink/40"
      >
        <path d="M7 8v28" strokeDasharray="3 3.5" />
        <path d="M3.5 11.5 7 8l3.5 3.5" />
        <path d="M3.5 32.5 7 36l-3.5-3.5" />
      </svg>
      <span className="font-code text-[10px] text-ink/35">commit → ticket</span>
    </div>
  );
}

export default function ReceiptsSection() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-[1fr_1.05fr]">
        {/* Left: the claim */}
        <div className="max-w-xl">
          <span className="text-xs font-medium uppercase tracking-wide text-ink/50">
            Provenance
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-[2rem]">
            Every task ends in a receipt.
          </h2>
          <p className="mt-4 leading-relaxed text-ink/65">
            A completed task records who proposed it, who approved it, which session claimed it,
            and the commit that closed it. The ticket id lives in the commit message and the
            commit hash lives in the task result — so the chain is traceable in both directions,
            from board to repo and back.
          </p>
        </div>

        {/* Right: the chain — done card, connector, git log */}
        <div className="min-w-0">
          {/* The done task card, in TaskBoard's card vocabulary */}
          <div className="rounded-lg border border-ink/10 bg-surface p-3.5 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-[14px] font-semibold leading-snug text-ink">
                <span className="mr-1.5 font-code text-[11px] font-medium tracking-tight text-ink/40">
                  {RECEIPT.ticket}
                </span>
                {RECEIPT.title}
              </span>
              <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Done
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink/60">
              {RECEIPT.result}{" "}
              <span className="inline-flex translate-y-[2px] items-center gap-1 rounded-[4px] border border-emerald-600/20 bg-emerald-500/10 px-1.5 py-0.5 font-code text-[10.5px] text-emerald-700 dark:text-emerald-300">
                <CommitIcon className="shrink-0" />
                {RECEIPT.commit}
              </span>
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink/10 pt-2 font-code text-[10px] text-ink/40">
              <span>
                proposed <span className="text-agent">{RECEIPT.proposedBy}</span>
              </span>
              <span>
                approved <span className="text-ink/70">{RECEIPT.approvedBy}</span>
              </span>
              <span>
                claimed <span className="text-agent">{RECEIPT.claimedBy}</span>
              </span>
            </div>
          </div>

          <ChainConnector />

          {/* The other end of the chain: the repo. Explicit dark ground so the
              terminal reads the same in both themes. */}
          <div className="overflow-hidden rounded-lg border border-white/10 bg-[#101014] text-zinc-200 shadow-sm">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
              <span className="h-2 w-2 rounded-full bg-white/15" />
              <span className="h-2 w-2 rounded-full bg-white/15" />
              <span className="font-code text-[10px] text-zinc-500">your repo</span>
            </div>
            <div className="overflow-x-auto px-4 py-3 font-code text-[11.5px] leading-relaxed">
              <div className="whitespace-nowrap text-zinc-400">
                <span className="text-indigo-400">$</span> git log --oneline | grep {RECEIPT.ticket}
              </div>
              <div className="mt-1 whitespace-nowrap">
                <span className="text-emerald-400/90">{RECEIPT.commit}</span>{" "}
                <span className="text-zinc-300">feat: rate-limit the websocket hub ({RECEIPT.ticket})</span>
              </div>
            </div>
          </div>

          <p className="mt-3 text-center text-[11px] text-ink/40">
            same ticket, same hash — board and repo agree
          </p>
        </div>
      </div>
    </section>
  );
}
