import { sendOp } from "./ws";
import type { CanvasMode } from "../types";

export interface Template {
  id: string;
  name: string;
  description: string;
  emoji: string;
  mode: CanvasMode;
  mapId?: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "map-us",
    name: "Map of the US",
    description: "Continental United States",
    emoji: "🇺🇸",
    mode: "map",
    mapId: "us",
  },
  {
    id: "map-world",
    name: "World map",
    description: "Zoomed-out global view",
    emoji: "🌍",
    mode: "map",
    mapId: "world",
  },
  {
    id: "map-tokyo",
    name: "Tokyo trip",
    description: "Greater Tokyo area",
    emoji: "🗼",
    mode: "map",
    mapId: "tokyo",
  },
  {
    id: "map-japan",
    name: "Japan",
    description: "All of Japan",
    emoji: "🗾",
    mode: "map",
    mapId: "japan",
  },
  {
    id: "itinerary",
    name: "Trip itinerary",
    description: "Day-by-day schedule",
    emoji: "📅",
    mode: "itinerary",
  },
  {
    id: "docs",
    name: "Blank doc",
    description: "Free-form notes",
    emoji: "📝",
    mode: "docs",
  },
];

export function applyTemplate(t: Template) {
  sendOp({
    op: "template.apply",
    templateId: t.id,
    mode: t.mode,
    ...(t.mapId ? { mapId: t.mapId } : {}),
  });
}

export const EXAMPLE_PROMPTS: string[] = [
  "Drop a pin for each of the top 10 US cities and a one-line note for each.",
  "Plan a 5-day Tokyo trip with pins for each stop and an itinerary.",
  "Switch to a map of Japan and add the top tourist spots.",
  "Make a packing checklist for a week of hiking.",
  "Add notes summarizing the key sights in each pin.",
];
