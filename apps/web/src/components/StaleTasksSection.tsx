import { AlertTriangle, Timer } from "lucide-react";
import type { CanvasState } from "../types";
import { useFreshnessNow } from "./Freshness";
import { countOpenTasks, deriveOldestOpenTasks, OLDEST_OPEN_LIMIT } from "../lib/oldestOpen";
import { ageOf, fullDate } from "../lib/relativeTime";
import { spaLink } from "../lib/spaNav";
import { CHIP_BASE, STATE_CHIP } from "../lib/stateChips";

/* ─────────────────────────────────────────────────────────────────────────────
   StaleTasksSection — the Summary surface's "Oldest open" section (TDM-195).

   The N oldest tasks that are still open, oldest first: what has been sitting
   on this board longest, without anyone having to scan the columns for it.

   A RANKING, NOT A THRESHOLD. An earlier cut flagged anything open past 48h as
   "stale"; on a board where a ticket waiting two days on a human approval is
   normal, that lit up half the queue and stopped carrying information. So there
   is no cutoff and no "stale" framing here — just the oldest ten, which is
   honest on a young board too. The definitions (what counts as open, what age
   measures, when a claim reads as gone dark) live where they are computed, in
   lib/oldestOpen.ts.

   AGE IS FROM createdAt. The canvas stores when a task was created, not when it
   entered its current state, so this cannot say "proposed for 3 days" — a task
   created a week ago and approved an hour ago still reads "open 7d". The wording
   ("open 7d", never "proposed for 7d") is what keeps that accurate.

   Self-contained by design (TDM-192's shell contract): it takes only `state` and
   `code`, so filling it in touched this file and its derivation, never
   SummaryPanel or a sibling section.
   ──────────────────────────────────────────────────────────────────────────── */

// The mark App.tsx puts on a ticket history entry so "Back to board" knows it
// can just go back (App.TICKET_PUSH_MARK — module-private there, mirrored here
// rather than reaching into App). Navigation is the app's existing pattern:
// pushState the ticket URL, then let App's popstate listener read the URL back —
// no router, no new route.
const TICKET_PUSH_MARK = "tandemTicketPushed";

function openTicket(code: string, ticketId: string) {
  window.history.pushState({ [TICKET_PUSH_MARK]: true }, "", `/c/${code}/ticket/${ticketId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function StaleTasksSection({
  state,
  code,
}: {
  /** The live canvas state — tasks live in `state.actions`. */
  state: CanvasState;
  /** Canvas code, for building links into the board / a ticket page. */
  code: string;
}) {
  // Ages have to tick on their own: a task nobody touches sends no push, and a
  // frozen "open 3m" on work that has been open an hour is exactly the lie this
  // section exists to avoid. Same clock the freshness chips use.
  const now = useFreshnessNow();
  const rows = deriveOldestOpenTasks(state, now);
  const openTotal = countOpenTasks(state);

  return (
    <section aria-labelledby="summary-oldest-open" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Timer size={15} strokeWidth={1.75} className="text-ink/40" />
        <h3 id="summary-oldest-open" className="text-[13px] font-semibold tracking-tight text-ink/80">
          Oldest open
        </h3>
        {openTotal > rows.length && (
          <span className="font-code text-[11px] text-ink/40">
            {rows.length} of {openTotal}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink/15 bg-surface px-4 py-6 text-[13px] text-ink/45">
          No open tasks.
        </div>
      ) : (
        <ul className="divide-y divide-ink/10 overflow-hidden rounded-md border border-ink/10 bg-surface">
          {rows.map((row) => {
            const chip = STATE_CHIP[row.state] ?? STATE_CHIP.proposed;
            const age = ageOf(row.createdAt);
            const created = fullDate(row.createdAt);

            const body = (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {row.ticketId && (
                    <span className="shrink-0 font-code text-[11px] font-medium tracking-tight text-ink/50">
                      {row.ticketId}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-ink">
                    {row.title}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1.5">
                  {row.staleClaim && (
                    <span
                      title="Its 15-minute claim lease has lapsed — the holder has gone quiet, and the next agent to ask for this task takes it over."
                      className={`${CHIP_BASE} flex items-center gap-1 bg-rose-500/10 text-rose-600 dark:text-rose-400`}
                    >
                      <AlertTriangle size={10} strokeWidth={2.25} />
                      Claim stale
                    </span>
                  )}
                  {row.holder && (
                    <span
                      title={`Claimed by ${row.holder}`}
                      className="hidden max-w-[10rem] truncate font-code text-[11px] text-ink/45 sm:inline"
                    >
                      {row.holder}
                    </span>
                  )}
                  <span className={`${CHIP_BASE} ${chip.chip}`}>{chip.label}</span>
                  <span
                    title={created ? `Created ${created}` : undefined}
                    className="w-[4.5rem] shrink-0 text-right font-code text-[11px] text-ink/45"
                  >
                    open {age}
                  </span>
                </span>
              </>
            );

            const rowClass =
              "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-ink/[0.03]";

            return (
              <li key={row.id}>
                {row.ticketId ? (
                  /* A real <a>, so cmd/middle-click opens the ticket in a new
                     tab; spaLink lets those modified clicks through and handles
                     the plain left click in-app. */
                  <a
                    href={`/c/${code}/ticket/${row.ticketId}`}
                    onClick={spaLink(() => openTicket(code, row.ticketId as string))}
                    title={`Open ${row.ticketId} — the full ticket page`}
                    className={`${rowClass} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
                  >
                    {body}
                  </a>
                ) : (
                  /* No ticket id (a task from before ticket numbering) — nothing
                     to deep-link to, so the row is plain text rather than a dead
                     link. */
                  <div className={rowClass}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] leading-snug text-ink/40">
        Open = not done, failed or rejected. Age counts from when the task was created — the canvas
        doesn&rsquo;t store time-in-state, so this is age on the board, not time in its current
        column. Showing the {OLDEST_OPEN_LIMIT} oldest.
      </p>
    </section>
  );
}
