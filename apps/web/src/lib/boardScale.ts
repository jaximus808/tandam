/* ── Mobile type scale (TDM-85) ───────────────────────────────────────────────
   The board's desktop scale is deliberately DENSE: five lanes side by side, so
   a card title is 13px and its record metadata 10px. On a phone none of those
   reasons hold — one lane is on screen at a time (TDM-86), the card is
   full-width, and the reading distance is shorter. Rendering the desktop sizes
   unchanged is how a dense-by-design board turns into a cramped one.

   So the scale is MOBILE-FIRST here: the bare size is the PHONE size and `sm:`
   restores the desktop density verbatim — ≥640px is unchanged, pixel for pixel.
   Written as constants because the same few rungs recur across cards, sidebar
   rows and column headers, and a scale is only a scale if it is applied once.

   This pairs with the text-size-adjust fix in index.css: until iOS stopped
   font-boosting the wide kanban, tuning these numbers was pointless because the
   browser was overriding them anyway.

   Lifted out of TaskBoard.tsx by TDM-163, when the proposed-epic review became
   a component of its own and had to render on the same rungs. Nothing about the
   values changed in the move — its own note above says a scale is only a scale
   if it is applied once, and two files sharing it is exactly that case. */

/** Card titles. */
export const T_TITLE = "text-[14px] sm:text-[13px]";
/** Sidebar epic + pseudo-entry titles (one rung below a card title). */
export const T_ROW = "text-[13.5px] sm:text-[12.5px]";
/** Record metadata: ticket chips, ages, counts — the smallest readable rung. */
export const T_META = "text-[11px] sm:text-[10px]";
/** Column headers and the uppercase group labels. */
export const T_HEAD = "text-[11.5px] sm:text-[11px]";
/** In-card and in-row action buttons (approve / reject / state moves). */
export const T_BTN = "text-[12px] sm:text-[11px]";
/** Comfortable touch height for a real control, collapsing to dense on sm+.
    The rule itself lives in index.css as `.tandem-tap` so the composer, the
    sheets and the dialogs share ONE definition of the floor rather than each
    re-deriving it. */
export const TAP = "tandem-tap";
