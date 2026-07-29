import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { FreshnessFields, FreshnessPatchFields } from "../types";
import {
  SHELF_LIVES,
  deriveFreshness,
  formatAge,
  freshnessSentence,
  shelfLifeLabel,
  unverifyPatch,
  verifiedAtMs,
  verifyPatch,
  type Freshness,
} from "../lib/freshness";

/* TDM-31 (E1.5) — the two controls the freshness model surfaces: a chip that
   READS a piece of context's trust status, and the act of VOUCHING for it.

   Design brief, in one line: an instrument readout, not a badge.

   Freshness is a second axis over content that already carries task-state chips
   (lib/stateChips), so it deliberately does NOT borrow their loud uppercase
   pill — two competing pill systems on one row is how a board turns to soup.
   Instead: a status dot plus the verified age in the mono face, because the age
   is a measurement and measurements are machine text (Design v2 Precision
   Canon). Hue stays inside the closed semantic set — emerald / amber / rose,
   no new colours.

   The states earn different volumes, which is the whole point of showing decay:
     fresh   solid emerald dot, age in ink/40 — present, silent, ignorable.
     aging   hollow amber ring, amber text — a raised eyebrow, no fill.
     stale   solid rose dot in a rose/10 well — the one state that interrupts.
     unknown NOTHING. Never-verified is the default state of nearly every item
             on a canvas; badging it would put a marker on everything and teach
             people to stop seeing markers. "Nobody vouched for this" is also
             not a warning — it's the absence of a claim, and absence renders as
             absence.

   Shape carries the same information as hue (solid / hollow / filled well), so
   the status survives a colourblind reader, and the full sentence rides along
   as both `title` and screen-reader text. */

// ── The clock ────────────────────────────────────────────────────────────────

/** Freshness is derived from `now`, so `now` has to move or a page left open
 *  would show yesterday's verdict. A minute is the finest granularity any label
 *  here renders ("9m"), so ticking faster would only cost renders. */
export function useFreshnessNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── The chip ─────────────────────────────────────────────────────────────────

type Tone = { well: string; dot: string; text: string };

const TONE: Record<Exclude<Freshness, "unknown">, Tone> = {
  fresh: { well: "", dot: "bg-emerald-500", text: "text-ink/40" },
  aging: {
    well: "",
    dot: "border border-amber-500 bg-transparent",
    text: "text-amber-600 dark:text-amber-400",
  },
  stale: { well: "bg-rose-500/10", dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" },
};

export function FreshnessChip({
  item,
  now,
  /** "chip" = dot + age (default). "dot" = the dot alone, for dense rows like
   *  the document tab strip where a second piece of text would crowd the name. */
  variant = "chip",
  className = "",
}: {
  item: FreshnessFields | undefined;
  now: number;
  variant?: "chip" | "dot";
  className?: string;
}) {
  const status = deriveFreshness(item, now);
  if (status === "unknown") return null;

  const tone = TONE[status];
  const sentence = freshnessSentence(item, status, now);
  const verifiedAt = verifiedAtMs(item);
  const age = formatAge(Math.max(0, now - (verifiedAt ?? now)));

  return (
    <span
      title={sentence}
      className={[
        "inline-flex shrink-0 items-center gap-1 rounded-[4px] align-middle",
        variant === "chip" ? "px-1.5 py-px" : "",
        tone.well,
        className,
      ].join(" ")}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      {variant === "chip" && (
        <>
          {/* Only stale is named. It's the one state that asks for something,
              and a rose chip reading just "3w" could as easily be a timestamp —
              the word is what makes it a verdict. Escalation by volume: fresh
              is silent, aging tints, stale speaks. */}
          {status === "stale" && (
            <span aria-hidden className={`text-[10px] font-medium leading-none ${tone.text}`}>
              Stale
            </span>
          )}
          <span aria-hidden className={`font-code text-[10.5px] leading-none ${tone.text}`}>
            {age}
          </span>
        </>
      )}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

// ── The act of vouching ──────────────────────────────────────────────────────

/** Verifying is a human saying "I read this and it is still true" — the one
 *  input the whole freshness model runs on, and deliberately separate from
 *  editing (fixing a typo must not re-certify a page nobody re-read).
 *
 *  A split control: the button vouches for it as of now and keeps whatever
 *  shelf life was declared; the caret opens the shelf life, because how fast a
 *  fact rots is a property of the fact, not a setting, and belongs next to the
 *  act rather than in a preferences screen. */
export function VerifyControl({
  item,
  onPatch,
  /** Icon-only trigger for dense rows. */
  compact = false,
  /** Keep the control on screen at rest. Default is to hide until the row is
   *  hovered (or focused, or touched); callers turn this on for the places
   *  where verifying is the point — an item that has aged out, or a document
   *  header where the control has to be findable without a hover to guess at. */
  alwaysVisible = false,
  className = "",
}: {
  item: FreshnessFields | undefined;
  onPatch: (patch: FreshnessPatchFields) => void;
  compact?: boolean;
  alwaysVisible?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  // The reveal is computed HERE, not handed in as a class, so an open menu can
  // never fade out from under the pointer: Safari doesn't focus a button on
  // click, so `focus-within` alone would drop the menu the moment the mouse
  // left the row. Two conflicting opacity utilities would also leave the
  // outcome to stylesheet order — this way there is only ever one.
  const reveal =
    alwaysVisible || open
      ? ""
      : "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100";

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const verified = verifiedAtMs(item) !== null;
  const shelfLife = item?.staleAfterSeconds ?? null;

  function verify(shelf?: number | null) {
    onPatch(verifyPatch(Date.now(), shelf));
    setOpen(false);
  }

  const segment =
    "border border-ink/15 bg-surface text-ink/55 transition-colors hover:border-ink/30 hover:text-ink " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  return (
    <div className={`relative flex shrink-0 items-center ${reveal} ${className}`}>
      <button
        type="button"
        onClick={() => verify()}
        title={
          verified
            ? "Mark verified again, as of now — the shelf life stays as it is"
            : "Vouch for this: mark it verified as of now"
        }
        className={[
          "inline-flex items-center gap-1 rounded-l-md border-r-0 py-0.5 text-[11px] font-medium",
          compact ? "px-1" : "pl-1.5 pr-2",
          segment,
        ].join(" ")}
      >
        <Check size={11} strokeWidth={2.25} />
        {!compact && "Verify"}
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Verify and set a shelf life"
        title="Verify and set a shelf life"
        className={`rounded-r-md px-1 py-0.5 ${segment}`}
      >
        <ChevronDown size={11} strokeWidth={2.25} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-ink/10 bg-surface py-1 text-left shadow-lg"
          >
            <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-ink/45">
              Verify · goes stale after
            </div>
            {SHELF_LIVES.map((option) => {
              const current = option.seconds === shelfLife;
              return (
                <button
                  key={option.label}
                  role="menuitem"
                  onClick={() => verify(option.seconds)}
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-ink/5"
                >
                  <span className="mt-[3px] w-3 shrink-0 text-accent">
                    {current && <Check size={11} strokeWidth={2.5} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink/80">{option.label}</span>
                    <span className="block text-[11px] leading-snug text-ink/45">{option.hint}</span>
                  </span>
                </button>
              );
            })}
            {verified && (
              <>
                <div className="my-1 h-px bg-ink/10" />
                <button
                  role="menuitem"
                  onClick={() => {
                    onPatch(unverifyPatch());
                    setOpen(false);
                  }}
                  title={`Currently: ${shelfLifeLabel(shelfLife)}`}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] font-medium text-ink/60 hover:bg-ink/5 hover:text-rose-600 dark:hover:text-rose-400"
                >
                  <span className="w-3 shrink-0" />
                  Clear verification
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
