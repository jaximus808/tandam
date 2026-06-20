import type { CanvasState, CanvasEvent, Pin } from "../types";
import { dayOf, instantMs } from "./itineraryTime";
import { eventPinIds } from "./eventPins";

// A cluster of pins that belong to the same itinerary day AND sit close
// enough together to share a single floating "day label" on the map.
// One day can produce multiple clusters when its pins are far apart
// (e.g. Day 1 = depart Denver + arrive DC → two clusters, one label each).
export interface DayCluster {
  dayKey: string;            // YYYY-MM-DD (output of dayOf)
  dayTag: string | null;     // first non-empty dayTag on this day, or null
  centroid: [number, number]; // [lat, lng] of the cluster centroid
  pinIds: string[];
}

// Greedy single-pass clustering threshold, in degrees of lat/lng. ~2° ≈ a few
// hundred km, which keeps "Denver metro" pins together while leaving "Denver
// vs DC" as separate clusters. Tunable.
const CLUSTER_THRESHOLD_DEG = 2;

interface Acc {
  sumLat: number;
  sumLng: number;
  count: number;
  pinIds: string[];
}

function pinsForEvent(ev: CanvasEvent): string[] {
  // eventPinIds intentionally excludes travel endpoints, but on the map a
  // travel event's from/to pins still belong to that day's cluster.
  const out = [...eventPinIds(ev)];
  if (ev.fromPinId) out.push(ev.fromPinId);
  if (ev.toPinId) out.push(ev.toPinId);
  return out;
}

export function buildDayClusters(state: CanvasState): DayCluster[] {
  const events = Object.values(state.events);
  if (events.length === 0) return [];

  // Each pin's canonical day = the earliest day any event references it.
  // dayKey strings are YYYY-MM-DD so lexicographic min == chronological min.
  const pinDay = new Map<string, string>();
  // For each day key, accumulate the dayTag — picking the first non-empty
  // tag among events on that day, sorted by start instant.
  type DayMeta = { tag: string | null; tagStartMs: number };
  const dayMeta = new Map<string, DayMeta>();

  for (const ev of events) {
    const dayKey = dayOf(ev.start, ev.timezone);
    for (const pinId of pinsForEvent(ev)) {
      const prev = pinDay.get(pinId);
      if (!prev || dayKey < prev) pinDay.set(pinId, dayKey);
    }
    if (ev.dayTag && ev.dayTag.trim() !== "") {
      const startMs = instantMs(ev.start);
      const cur = dayMeta.get(dayKey);
      if (!cur || !cur.tag || startMs < cur.tagStartMs) {
        dayMeta.set(dayKey, { tag: ev.dayTag.trim(), tagStartMs: startMs });
      }
    } else if (!dayMeta.has(dayKey)) {
      dayMeta.set(dayKey, { tag: null, tagStartMs: Number.POSITIVE_INFINITY });
    }
  }

  // Bucket pins by their canonical day, dropping any that don't resolve to a
  // real Pin (deleted or otherwise missing from state).
  const pinsByDay = new Map<string, Pin[]>();
  for (const [pinId, dayKey] of pinDay) {
    const pin = state.pins[pinId];
    // Skip missing pins and any with non-finite coords — a NaN would poison the
    // cluster centroid and produce an invalid Leaflet marker position.
    if (!pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) continue;
    const arr = pinsByDay.get(dayKey) ?? [];
    arr.push(pin);
    pinsByDay.set(dayKey, arr);
  }

  const clusters: DayCluster[] = [];
  for (const [dayKey, pinsOfDay] of pinsByDay) {
    const accs: Acc[] = [];
    for (const pin of pinsOfDay) {
      let placed = false;
      for (const acc of accs) {
        const cLat = acc.sumLat / acc.count;
        const cLng = acc.sumLng / acc.count;
        const dLat = pin.lat - cLat;
        const dLng = pin.lng - cLng;
        if (Math.hypot(dLat, dLng) <= CLUSTER_THRESHOLD_DEG) {
          acc.sumLat += pin.lat;
          acc.sumLng += pin.lng;
          acc.count += 1;
          acc.pinIds.push(pin.id);
          placed = true;
          break;
        }
      }
      if (!placed) {
        accs.push({ sumLat: pin.lat, sumLng: pin.lng, count: 1, pinIds: [pin.id] });
      }
    }
    const tag = dayMeta.get(dayKey)?.tag ?? null;
    for (const acc of accs) {
      clusters.push({
        dayKey,
        dayTag: tag,
        centroid: [acc.sumLat / acc.count, acc.sumLng / acc.count],
        pinIds: acc.pinIds,
      });
    }
  }

  return clusters;
}
