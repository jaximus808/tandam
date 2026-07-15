import type { Note } from "../types";

// Outline titles are DERIVED from the note body, never stored. A note has no
// title field and shouldn't grow one: the heading you already typed is the
// title, so the outline can't drift out of sync with the prose.

const MAX_TITLE = 40;

// Strip the inline Markdown that would otherwise show up as literal punctuation
// in the outline (**bold**, _em_, `code`, [link](url)). Bodies are Markdown, so
// without this a heading like "## **Day 1**" reads as "**Day 1**" in the rail.
function stripInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links / images → their text
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string): string {
  if (s.length <= MAX_TITLE) return s;
  return s.slice(0, MAX_TITLE - 1).trimEnd() + "…";
}

/**
 * The outline label for a note: its first Markdown heading, else its first
 * non-empty line, else "Untitled". Truncated to fit the rail.
 */
export function noteTitle(body: string): string {
  const lines = body.split("\n");

  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const t = stripInline(heading[1]);
      if (t) return truncate(t);
    }
  }

  for (const line of lines) {
    // Drop a leading list bullet / quote / numbering so the label is the text
    // itself rather than the marker in front of it.
    const t = stripInline(line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, ""));
    if (t) return truncate(t);
  }

  return "Untitled";
}

/**
 * Document order: authored `sortOrder` first, `updatedAt` only as a tie-break
 * for rows that share one (e.g. the 0-default before migration 0030's backfill
 * lands). Deliberately NOT sorted by updatedAt — that's what made editing a note
 * jerk it to the bottom of the page.
 */
export function sortNotes(notes: Note[]): Note[] {
  return notes
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt - b.updatedAt);
}
