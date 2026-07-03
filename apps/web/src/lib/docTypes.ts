import type { CanvasMode, DocumentType } from "../types";

/* Documents (migration 0024) are the canvas's tabs. A document's `type` maps to
   the existing per-type "mode" that renders it (and carries its accent colour via
   modeTheme). This is the one place that mapping lives. */

export const DOC_TYPE_TO_MODE: Record<DocumentType, CanvasMode> = {
  map: "map",
  notes: "docs",
  itinerary: "itinerary",
  roadmap: "roadmap",
  sheet: "sheets",
  chart: "charts",
};

export const DOC_TYPE_LABEL: Record<DocumentType, string> = {
  map: "Map",
  notes: "Notes",
  itinerary: "Itinerary",
  roadmap: "Roadmap",
  sheet: "Sheet",
  chart: "Chart",
};

// Types a user can spin up from the "+" tab menu. Charts are excluded — a chart
// needs a source sheet, so it's born from within the Sheets/Charts flow, not here.
export const CREATABLE_DOC_TYPES: DocumentType[] = [
  "map",
  "notes",
  "itinerary",
  "roadmap",
  "sheet",
];
