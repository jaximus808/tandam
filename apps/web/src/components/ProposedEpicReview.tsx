import { FileCode, Target, TriangleAlert } from "lucide-react";
import {
  WARNING_LABEL,
  WARNING_ORDER,
  type PlanReview,
  type TicketReview,
} from "@agentcanvas/shared/ticket-quality";
import { T_HEAD, T_META, TAP } from "../lib/boardScale";

/* ─────────────────────────────────────────────────────────────────────────────
   A proposed epic reads as a PLAN, not as a pile of cards (TDM-163)

   The claim this product makes at the plan gate is "you can see it is slop in
   twenty seconds". That only holds if a proposed epic is judgeable AS A WHOLE —
   eleven tickets read at a glance, on a phone, without tapping into one of
   them. Until this, a proposed epic rendered as eleven title-only cards: the
   surface each ticket touched and the condition it claimed to be done by were
   both one tap away each, so checking a plan of eleven cost twenty-two taps and
   nobody was going to pay it. Approving everything is what that surface asks
   for, which makes the gate a rubber stamp with extra steps.

   Two pieces, both derived, neither a new visual language:

     · PlanDigest — the batch read at once, in the scoped-epic header: how many
       tickets, which packages the whole plan touches, and how many tickets the
       quality contract has something to say about (with the counts per kind, so
       "vague" and "too big" are different findings rather than one number).

     · TicketReviewLines — three quiet lines under a card's title: what it says
       it touches, how you would know it is done, and any warnings. These are
       what make the LIST judgeable, which is the whole ticket.

   The signals themselves come from `@agentcanvas/shared/ticket-quality` — the
   ONE implementation of TDM-159's contract, which the MCP gateway runs at
   propose time and the board runs here (it was a hand-copied mirror in
   lib/ticketQuality until TDM-169 hoisted it). See the long note there for why
   the rules stay client-evaluable at all. Nothing here decides anything: the
   digest's one control sorts, and every verb on this surface still belongs to
   TDM-160's per-ticket triage and TDM-164's selection.
   ──────────────────────────────────────────────────────────────────────────── */

/** An amber warning chip: the same weight the board already gives a stalled
 *  lease. Warnings are advisory — nothing here blocks an approval — so they sit
 *  one step below the rose a reviewer's block earns (TDM-157) and one above the
 *  ink/45 the record metadata reads at. */
const WARN_CHIP =
  "inline-flex min-w-0 shrink items-center gap-1 rounded-[4px] bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400 sm:py-px";

/** A surface the ticket names, in the code face — it is a path, and printing a
 *  path in prose type is how you make it look like prose. */
const SURFACE_CHIP =
  "inline-flex min-w-0 shrink items-center rounded-[4px] border border-ink/10 bg-ink/[0.03] px-1.5 py-0.5 font-code text-ink/60 sm:py-px";

/** How many surfaces a card prints before it counts the rest. Two is what fits
 *  beside a ticket ref on a 390px screen; the rest are one tap away, and by
 *  then you have already decided this is the card worth tapping. */
const SURFACES_SHOWN = 2;

/* ── The batch, read at once ──────────────────────────────────────────────── */

export function PlanDigest({
  review,
  flaggedFirst,
  onToggleFlaggedFirst,
}: {
  review: PlanReview;
  /** Whether the Proposed lane is currently sorting warned tickets to the top. */
  flaggedFirst: boolean;
  onToggleFlaggedFirst: () => void;
}) {
  const flagged = review.flagged.size;
  const codes = WARNING_ORDER.filter((c) => (review.counts.get(c) ?? 0) > 0);
  return (
    <div className="mt-2 rounded-md border border-ink/10 bg-ink/[0.02] px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/45">
          Plan review
        </span>
        <span className={`font-code text-ink/50 ${T_META}`}>
          {review.total} ticket{review.total === 1 ? "" : "s"}
        </span>
        {/* The one control. It does not decide anything — it answers "which of
            these should I read first", which is the question a reviewer with
            eleven tickets and four minutes actually has. Off by default,
            because a plan's own order is part of its argument (ticket 7 often
            only makes sense after ticket 3) and silently resequencing it would
            cost more than it saves. */}
        {flagged > 0 && (
          <button
            onClick={onToggleFlaggedFirst}
            aria-pressed={flaggedFirst}
            title={
              flaggedFirst
                ? "Back to the plan's own order"
                : "Sort the flagged tickets to the top of the Proposed lane"
            }
            className={[
              "ml-auto flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 sm:py-0.5",
              T_META,
              TAP,
              flaggedFirst
                ? "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-ink/15 text-ink/60 hover:border-amber-500/45 hover:text-amber-700 dark:hover:text-amber-400",
            ].join(" ")}
          >
            <TriangleAlert size={10} className="shrink-0" aria-hidden="true" />
            {flagged} flagged
            <span className="opacity-70">{flaggedFirst ? "· first" : "· read first"}</span>
          </button>
        )}
      </div>

      {/* What the whole plan touches. A batch that names no package at all is
          the loudest signal on this panel — it means eleven tickets went by
          without one of them saying where the work lands — so it is stated
          rather than left as an absent row. */}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
        <span className={`shrink-0 text-ink/45 ${T_HEAD}`}>Touches</span>
        {review.packages.length > 0 ? (
          review.packages.map((pkg) => (
            <span key={pkg} className={`${SURFACE_CHIP} ${T_META}`}>
              {pkg}
            </span>
          ))
        ) : (
          <span className={`min-w-0 text-amber-700 dark:text-amber-400 ${T_HEAD}`}>
            no package named anywhere in the batch
          </span>
        )}
      </div>

      {/* Where it is vague, by kind. One number would be a score; these are
          findings, and "three tickets state no done condition" is a sentence a
          person can act on where "4 flagged" is not. */}
      {codes.length > 0 ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
          {codes.map((code) => (
            <span key={code} className={`${WARN_CHIP} ${T_META}`}>
              <span className="font-code">{review.counts.get(code)}</span>
              {WARNING_LABEL[code]}
            </span>
          ))}
        </div>
      ) : (
        review.total > 0 && (
          <p className={`mt-1.5 text-ink/50 ${T_HEAD}`}>
            Every ticket names a surface and states a done condition.
          </p>
        )
      )}
    </div>
  );
}

/* ── One ticket, judgeable without opening it ─────────────────────────────── */

export function TicketReviewLines({
  review,
  className = "",
}: {
  review: TicketReview | undefined;
  className?: string;
}) {
  if (!review) return null;
  const { surfaces, done, warnings } = review;
  // A ticket that names nothing, promises nothing and trips nothing has no rows
  // to draw — rather than three empty ones.
  if (surfaces.length === 0 && !done && warnings.length === 0) return null;
  const shown = surfaces.slice(0, SURFACES_SHOWN);
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      {/* What it touches. Suppressed when nothing is named — the warning chip
          below says so in words, and an empty row saying nothing twice is the
          kind of chrome that makes a dense card unreadable. */}
      {shown.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <FileCode size={10} className="shrink-0 text-ink/35" aria-hidden="true" />
          {shown.map((s) => (
            <span key={s} className={`${SURFACE_CHIP} max-w-full truncate ${T_META}`} title={s}>
              {s}
            </span>
          ))}
          {surfaces.length > shown.length && (
            <span className={`shrink-0 font-code text-ink/40 ${T_META}`}>
              +{surfaces.length - shown.length}
            </span>
          )}
        </div>
      )}
      {/* How you would know it is finished — the single most useful line on a
          proposed ticket, and the one that used to cost a tap. Clamped to two
          lines: past that it is a body, and a body belongs in the ticket. */}
      {done && (
        <div className="flex min-w-0 items-start gap-1">
          <Target size={10} className="mt-[3px] shrink-0 text-ink/35" aria-hidden="true" />
          <span className={`line-clamp-2 min-w-0 leading-snug text-ink/60 ${T_HEAD}`} title={done}>
            {done}
          </span>
        </div>
      )}
      {/* What the quality contract has against it. The full sentence is on the
          chip's title, because the chip has to fit on a phone and the argument
          for the finding does not. */}
      {warnings.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {warnings.map((w) => (
            <span key={w.code} className={`${WARN_CHIP} ${T_META}`} title={w.message}>
              <TriangleAlert size={9} className="shrink-0" aria-hidden="true" />
              {WARNING_LABEL[w.code]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
