// Hardcoded canvas fixture for offline UI iteration.
// Activated by setting VITE_MOCK=1 (see package.json `dev:mock`).
// When on, the WS layer and API layer use in-memory state instead of the server.

import type {
  CanvasMeta,
  CanvasState,
  Note,
  Pin,
  CanvasEvent,
  RoadmapItem,
  Sheet,
  SheetRow,
  EntityId,
} from "../types";

export const MOCK_ENABLED = import.meta.env.VITE_MOCK === "1";

let counter = 0;
const id = (): EntityId => `mock-${++counter}`;

const pin1Id = id();
const pin2Id = id();
const pin3Id = id();
const pinKyotoId = id();
const pinSfoId = id();
const event1Id = id();
const event2Id = id();
const eventFlightId = id();
const eventTrainId = id();
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
  {
    id: pinKyotoId,
    kind: "pin",
    pinType: "marker",
    lat: 35.0116,
    lng: 135.7681,
    label: "Kyoto",
    body: "Old capital, day trip from Tokyo via Shinkansen.",
    color: "#8b5cf6",
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: pinSfoId,
    kind: "pin",
    pinType: "marker",
    lat: 37.6213,
    lng: -122.379,
    label: "SFO",
    body: "Home base — return leg lands here.",
    color: "#0ea5e9",
    createdBy: "agent",
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
  {
    id: eventTrainId,
    kind: "event",
    title: "Shinkansen to Kyoto",
    start: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    end: new Date(Date.now() + 74.25 * 3600 * 1000).toISOString(),
    fromPinId: pin1Id,
    toPinId: pinKyotoId,
    travelMode: "train",
    createdBy: "agent",
    updatedAt: Date.now(),
  },
  {
    id: eventFlightId,
    kind: "event",
    title: "Return flight NRT → SFO",
    start: new Date(Date.now() + 120 * 3600 * 1000).toISOString(),
    end: new Date(Date.now() + 130 * 3600 * 1000).toISOString(),
    fromPinId: pinKyotoId,
    toPinId: pinSfoId,
    travelMode: "flight",
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

const launchId = id();
const authId = id();
const authJwtId = id();
const authSsoId = id();
const billingId = id();
const billingStripeId = id();
const billingInvoiceId = id();
const onboardingId = id();
const q3Id = id();
const dashId = id();
const bugBashId = id();
const techDebtId = id();
const loggerId = id();

const roadmapItems: RoadmapItem[] = [
  // Top-level: Launch v2 (in progress, 3 children)
  { id: launchId, kind: "roadmap", title: "🚀 Launch v2",
    body: "", status: "in_progress", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
  { id: authId, kind: "roadmap", parentId: launchId, title: "Auth rewrite",
    body: "", status: "done", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
  { id: authJwtId, kind: "roadmap", parentId: authId, title: "Migrate JWT signing key",
    body: "", status: "done", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
  { id: authSsoId, kind: "roadmap", parentId: authId, title: "SSO support (Okta + Google)",
    body: "", status: "in_progress", sortOrder: 1,
    createdBy: "agent", updatedAt: Date.now() },
  { id: billingId, kind: "roadmap", parentId: launchId, title: "Billing pipeline",
    body: "", status: "todo", sortOrder: 1,
    createdBy: "agent", updatedAt: Date.now() },
  { id: billingStripeId, kind: "roadmap", parentId: billingId, title: "Stripe webhooks",
    body: "", status: "todo", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
  { id: billingInvoiceId, kind: "roadmap", parentId: billingId, title: "Invoice email templates",
    body: "", status: "blocked", sortOrder: 1,
    createdBy: "user", updatedAt: Date.now() },
  { id: onboardingId, kind: "roadmap", parentId: launchId, title: "Onboarding redesign",
    body: "", status: "in_progress", sortOrder: 2,
    createdBy: "agent", updatedAt: Date.now() },

  // Top-level: Q3 polish (todo, 2 children)
  { id: q3Id, kind: "roadmap", title: "📊 Q3 polish",
    body: "", status: "todo", sortOrder: 1,
    createdBy: "agent", updatedAt: Date.now() },
  { id: dashId, kind: "roadmap", parentId: q3Id, title: "Dashboard perf audit",
    body: "", status: "todo", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
  { id: bugBashId, kind: "roadmap", parentId: q3Id, title: "Bug bash week",
    body: "", status: "todo", sortOrder: 1,
    createdBy: "user", updatedAt: Date.now() },

  // Top-level: Tech debt (blocked, 1 child)
  { id: techDebtId, kind: "roadmap", title: "🐛 Tech debt",
    body: "", status: "blocked", sortOrder: 2,
    createdBy: "agent", updatedAt: Date.now() },
  { id: loggerId, kind: "roadmap", parentId: techDebtId, title: "Migrate off legacy logger",
    body: "", status: "blocked", sortOrder: 0,
    createdBy: "agent", updatedAt: Date.now() },
];

// ── Sheets seed: hotel comparison (exercises all four column types) ──────────
const hotelSheetId = id();
const colHotelId = id();
const colPriceId = id();
const colStarsId = id();
const colBookedId = id();
const colCheckinId = id();

const sheetRowHiltonId = id();
const sheetRowMarriottId = id();
const sheetRowHyattId = id();
const sheetRowAirbnbId = id();

const sheets: Sheet[] = [
  {
    id: hotelSheetId,
    kind: "sheet",
    name: "Hotel comparison",
    sortOrder: 0,
    columns: [
      { id: colHotelId,   name: "Hotel",     type: "text",     sortOrder: 0 },
      { id: colPriceId,   name: "Price/night", type: "number", sortOrder: 1 },
      { id: colStarsId,   name: "Stars",     type: "number",   sortOrder: 2 },
      { id: colBookedId,  name: "Booked",    type: "checkbox", sortOrder: 3 },
      { id: colCheckinId, name: "Check-in",  type: "date",     sortOrder: 4 },
    ],
    createdBy: "agent",
    updatedAt: Date.now(),
  },
];

const sheetRows: SheetRow[] = [
  {
    id: sheetRowHiltonId, kind: "sheetRow", sheetId: hotelSheetId, sortOrder: 0,
    data: { [colHotelId]: "Hilton Tokyo", [colPriceId]: 285, [colStarsId]: 4, [colBookedId]: true,  [colCheckinId]: "2026-07-12" },
    createdBy: "agent", updatedAt: Date.now(),
  },
  {
    id: sheetRowMarriottId, kind: "sheetRow", sheetId: hotelSheetId, sortOrder: 1,
    data: { [colHotelId]: "Marriott Shinjuku", [colPriceId]: 220, [colStarsId]: 4, [colBookedId]: false, [colCheckinId]: "2026-07-12" },
    createdBy: "agent", updatedAt: Date.now(),
  },
  {
    id: sheetRowHyattId, kind: "sheetRow", sheetId: hotelSheetId, sortOrder: 2,
    data: { [colHotelId]: "Park Hyatt Tokyo", [colPriceId]: 510, [colStarsId]: 5, [colBookedId]: false, [colCheckinId]: "2026-07-12" },
    createdBy: "agent", updatedAt: Date.now(),
  },
  {
    id: sheetRowAirbnbId, kind: "sheetRow", sheetId: hotelSheetId, sortOrder: 3,
    data: { [colHotelId]: "Airbnb in Shibuya", [colPriceId]: 165, [colStarsId]: 3, [colBookedId]: false, [colCheckinId]: "2026-07-13" },
    createdBy: "user", updatedAt: Date.now(),
  },
];

const initialCanvas: CanvasMeta = {
  id: "mock-canvas",
  code: "MOCKCNV1",
  name: "Mock Canvas (offline)",
  mode: "sheets",
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
  mode: "sheets",
  pins: toRecord(pins),
  events: toRecord(events),
  notes: toRecord(notes),
  roadmapItems: toRecord(roadmapItems),
  sheets: toRecord(sheets),
  sheetRows: toRecord(sheetRows),
  charts: {},
  actions: {},
  agents: {},
};

export const mockCanvas: CanvasMeta = initialCanvas;
export const mockState: CanvasState = initialState;
export const mockNewId = id;
