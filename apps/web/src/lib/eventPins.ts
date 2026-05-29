import type { CanvasEvent } from "../types";

// The pins an itinerary entry covers. Prefer the multi-pin list; fall back to
// the legacy single pinId. Travel endpoints (fromPinId/toPinId) are handled
// separately as routes and are intentionally not included here.
export function eventPinIds(ev: CanvasEvent): string[] {
  if (ev.pinIds && ev.pinIds.length > 0) return ev.pinIds;
  if (ev.pinId) return [ev.pinId];
  return [];
}
