// Shared task/epic state visuals — Design System v2 ("Precision Canon").
//
// The closed six-hue semantic state set (see /DESIGN.md §Tokens):
//   proposed amber · ready sky · working violet · done emerald · failed rose ·
//   rejected zinc — backgrounds at /10 alpha, text at 600 (light) / 400 (dark).
// This is the ONE definition; TaskBoard (and any future task surface) imports
// it rather than carrying its own hex tables. No new hues.

export interface StateChipDef {
  label: string;
  /** Chip fill + text: hue/10 background, 600 text (light) / 400 (dark). */
  chip: string;
  /** Solid dot / progress-segment fill in the same hue. */
  dot: string;
  /** Text-only treatment (claimant chips, inline annotations). */
  text: string;
}

/** Base chip shell shared by every state chip (pill-adjacent 4px radius). */
export const CHIP_BASE =
  "shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]";

// Keyed by ActionState, but typed Record<string, …> so callers can keep the
// defensive `STATE_CHIP[state] ?? STATE_CHIP.proposed` lookup on raw strings.
export const STATE_CHIP: Record<string, StateChipDef> = {
  proposed: {
    label: "Proposed",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  approved: {
    label: "Ready",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-400",
  },
  executing: {
    label: "Working",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
  },
  done: {
    label: "Done",
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    chip: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
  },
  rejected: {
    label: "Rejected",
    chip: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
    dot: "bg-zinc-400",
    text: "text-zinc-500 dark:text-zinc-400",
  },
};
