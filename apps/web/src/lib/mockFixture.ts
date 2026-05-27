// Hardcoded canvas fixture for offline UI iteration.
// Activated by setting VITE_MOCK=1 (see package.json `dev:mock`).
// When on, the WS layer and API layer use in-memory state instead of the server.

import type { CanvasMeta, CanvasState, Note, Pin, CanvasEvent, EntityId } from "../types";

export const MOCK_ENABLED = import.meta.env.VITE_MOCK === "1";

let counter = 0;
const id = (): EntityId => `mock-${++counter}`;

const pin1Id = id();
const pin2Id = id();
const pin3Id = id();
const event1Id = id();
const event2Id = id();
const note1Id = id();
const note2Id = id();

const pins: Pin[] = [
  {
    id: pin1Id,
    kind: "pin",
    pinType: "marker",
    lat: 35.6895,
    lng: 139.6917,
    label: "Shibuya Crossing",
    body:
      "World's busiest pedestrian crossing. **Tip:** ride the escalator in Shibuya Station up to the upper level for the iconic overhead view.\n\n| Metric | Value |\n|---|---|\n| Daily crossings | ~3M |\n| Best photo time | Dusk |",
    color: "#3b82f6",
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: pin2Id,
    kind: "pin",
    pinType: "marker",
    lat: 35.7148,
    lng: 139.7967,
    label: "Sensō-ji Temple",
    body: "Tokyo's oldest temple, dating to 645 CE. Don't skip Nakamise-dōri for snacks on the way in.",
    color: "#ef4444",
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: pin3Id,
    kind: "pin",
    pinType: "marker",
    lat: 35.6586,
    lng: 139.7454,
    label: "Tokyo Tower",
    body: "",
    color: "#f59e0b",
    createdBy: "user",
    updatedAt: Date.now(),
  },
];

const events: CanvasEvent[] = [
  {
    id: event1Id,
    kind: "event",
    title: "Shibuya street photography walk",
    start: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    end: new Date(Date.now() + 27 * 3600 * 1000).toISOString(),
    pinId: pin1Id,
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: event2Id,
    kind: "event",
    title: "Sensō-ji at sunrise",
    start: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    pinId: pin2Id,
    createdBy: "agent",
    updatedAt: Date.now(),
  },
];

const notes: Note[] = [
  {
    id: note1Id,
    kind: "note",
    body: `# Trip plan: McLean → Snowmass

**Destination:** Anderson Ranch Arts Center, 5263 Owl Creek Rd

## Strategy comparison

| Option | Cost (RT) | Door-to-door | Pros | Cons |
|---|---|---|---|---|
| DCA → DEN + rental | $400–650 | ~8h | Cheapest, flexible | Long drive after flight |
| Fly to ASE | $430–580 | ~7h | Less driving | Weather cancellations |
| Fly to EGE | $550–700 | ~6h | Shorter drive | Limited flights |

## Recommended play-by-play

1. Log off Thursday 5pm ET
2. DCA → DEN nonstop (6:30pm)
3. Pick up rental, drive I-70 W → CO-82 W
4. Arrive Snowmass ~1am MT

> Alternative: hotel near DEN, drive Friday morning (you WFH Fridays).
`,
    imageRefs: [],
    parentId: pin1Id,
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: note2Id,
    kind: "note",
    body: "Quick reminder: pack the wide-angle lens for Shibuya. Also need a foldable tripod.",
    imageRefs: [],
    createdBy: "user",
    updatedAt: Date.now(),
  },
];

const initialCanvas: CanvasMeta = {
  id: "mock-canvas",
  code: "MOCKCNV1",
  name: "Mock Canvas (offline)",
  mode: "map",
  mapId: "tokyo",
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function toRecord<T extends { id: EntityId }>(arr: T[]): Record<EntityId, T> {
  const out: Record<EntityId, T> = {};
  for (const item of arr) out[item.id] = item;
  return out;
}

const initialState: CanvasState = {
  version: 1,
  mode: "map",
  pins: toRecord(pins),
  events: toRecord(events),
  notes: toRecord(notes),
};

export const mockCanvas: CanvasMeta = initialCanvas;
export const mockState: CanvasState = initialState;
export const mockNewId = id;
