import type { CanvasMode } from "../types";

/* ─────────────────────────────────────────────────────────────────────────────
   Per-mode accent identity. The landing page gives each use-case its own colour;
   inside a canvas we do the same per *mode*, so switching views visibly changes
   the room's accent — the active tab, the header rule, and each mode's primary
   action all pick it up. Colours intentionally mirror the landing's mode tints
   (Map=sky, Itinerary=amber, Docs=violet, Sheets=emerald, Roadmap=rose,
   Charts=indigo) so the marketing surface and the product feel like one thing.
   ───────────────────────────────────────────────────────────────────────────── */

export interface ModeTheme {
  /** The full-strength accent — solid fills, active dots, primary buttons. */
  solid: string;
  /** A faint wash for active-tab backgrounds and soft chips. */
  soft: string;
  /** A hairline tint for borders that should read as "this mode". */
  line: string;
  /** A hover-strength solid, slightly darker than `solid`. */
  hover: string;
}

export const MODE_THEME: Record<CanvasMode, ModeTheme> = {
  welcome: {
    solid: "#64748B",
    soft: "rgba(100,116,139,0.10)",
    line: "rgba(100,116,139,0.22)",
    hover: "#475569",
  },
  map: {
    solid: "#0EA5E9",
    soft: "rgba(14,165,233,0.10)",
    line: "rgba(14,165,233,0.24)",
    hover: "#0284C7",
  },
  itinerary: {
    solid: "#F59E0B",
    soft: "rgba(245,158,11,0.12)",
    line: "rgba(245,158,11,0.26)",
    hover: "#D97706",
  },
  docs: {
    solid: "#7C3AED",
    soft: "rgba(124,58,237,0.10)",
    line: "rgba(124,58,237,0.22)",
    hover: "#6D28D9",
  },
  roadmap: {
    solid: "#F43F5E",
    soft: "rgba(244,63,94,0.10)",
    line: "rgba(244,63,94,0.24)",
    hover: "#E11D48",
  },
  sheets: {
    solid: "#10B981",
    soft: "rgba(16,185,129,0.10)",
    line: "rgba(16,185,129,0.24)",
    hover: "#059669",
  },
  charts: {
    solid: "#6366F1",
    soft: "rgba(99,102,241,0.10)",
    line: "rgba(99,102,241,0.24)",
    hover: "#4F46E5",
  },
};

export function modeTheme(mode: CanvasMode | undefined): ModeTheme {
  return MODE_THEME[mode ?? "welcome"] ?? MODE_THEME.welcome;
}
