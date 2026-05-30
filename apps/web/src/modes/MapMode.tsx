import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasEvent, CanvasState, Pin, TravelMode } from "../types";
import { sendOp } from "../lib/ws";
import { imageUrl } from "../lib/api";

const MARKDOWN_PLUGINS = [remarkGfm];
import { useMapDefinition } from "../lib/useMapDefinition";
import type { MapLayer } from "../lib/maps";
import { useResizablePanel } from "../lib/useResizablePanel";
import { instantMs, formatTime, formatDay, dayOf } from "../lib/itineraryTime";
import { eventPinIds } from "../lib/eventPins";
import { buildDayClusters } from "../lib/dayClusters";

// Fix Leaflet default marker icons with bundlers
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface Props {
  canvasId: string;
  mapId?: string;
  state: CanvasState;
  // Whether this mode is currently the visible tab. Used to re-invalidate
  // Leaflet's size after the container goes from display:none back to visible
  // (kept-alive mode switching).
  active: boolean;
  selectedPinId: string | null;
  onSelectPin: (id: string | null) => void;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}

// ── Travel segment rendering ──────────────────────────────────────────────────
// A "travel event" is a CanvasEvent with fromPinId + toPinId + travelMode all
// set. It renders as a polyline between the two pins with a mode icon at the
// midpoint. Clicking either selects the event and fits the camera to both
// endpoints.

type LatLng = [number, number];

interface ResolvedTravel {
  event: CanvasEvent;
  from: Pin;
  to: Pin;
  mode: TravelMode;
}

const TRAVEL_STYLE: Record<TravelMode, { color: string; dashArray?: string }> = {
  flight: { color: "#3b82f6" },
  train:  { color: "#10b981" },
  drive:  { color: "#f59e0b", dashArray: "8 6" },
};

// Inlined Lucide SVG paths so we can drop them straight into divIcon HTML
// without pulling in react-dom/server.
const TRAVEL_ICON_SVG: Record<TravelMode, string> = {
  flight:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>' +
    "</svg>",
  train:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/>' +
    '<path d="m9 15-1-1"/>' +
    '<path d="m15 15 1-1"/>' +
    '<path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/>' +
    '<path d="m8 19-2 3"/>' +
    '<path d="m16 19 2 3"/>' +
    "</svg>",
  drive:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>' +
    '<circle cx="7" cy="17" r="2"/>' +
    '<path d="M9 17h6"/>' +
    '<circle cx="17" cy="17" r="2"/>' +
    "</svg>",
};

function bezierPoint(a: LatLng, c: LatLng, b: LatLng, t: number): LatLng {
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
    u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
  ];
}

// Apex of a flight arc. A lone flight bows northward (so it curves "up"
// regardless of direction). When `separate` is set — there's a return leg
// between the same two pins — it instead bows perpendicular to the direction of
// travel. Because that direction flips on the return, the two legs curve to
// opposite sides instead of overlapping, so a round trip reads as a loop rather
// than one arc retraced backwards. Magnitude scales with chord length (~20%).
function flightControlPoint(from: LatLng, to: LatLng, separate: boolean): LatLng {
  const dLat = to[0] - from[0];
  const dLng = to[1] - from[1];
  const midLat = (from[0] + to[0]) / 2;
  const midLng = (from[1] + to[1]) / 2;
  if (separate) {
    // Perpendicular to (dLat, dLng) is (-dLng, dLat); offset is ~20% of chord.
    return [midLat - dLng * 0.2, midLng + dLat * 0.2];
  }
  const chord = Math.hypot(dLat, dLng);
  return [midLat + chord * 0.2, midLng];
}

function travelPath(from: LatLng, to: LatLng, mode: TravelMode, separate: boolean): LatLng[] {
  if (mode !== "flight") return [from, to];
  const ctrl = flightControlPoint(from, to, separate);
  const samples = 32;
  const pts: LatLng[] = [];
  for (let i = 0; i <= samples; i++) {
    pts.push(bezierPoint(from, ctrl, to, i / samples));
  }
  return pts;
}

function travelMidpoint(from: LatLng, to: LatLng, mode: TravelMode, separate: boolean): LatLng {
  if (mode !== "flight") {
    return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  }
  return bezierPoint(from, flightControlPoint(from, to, separate), to, 0.5);
}

// Unordered key for a pin pair, so A→B and B→A collide in the same bucket.
function pinPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Bearing along the chord direction, in degrees clockwise from north — used to
// rotate the plane icon so it points along the travel direction. The Lucide
// Plane icon's nose points "up-right" (~45°) at rotation 0, so we subtract 45
// to compensate.
function travelBearing(from: LatLng, to: LatLng): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI - 45;
}

function travelIcon(mode: TravelMode, bearing: number, selected: boolean): L.DivIcon {
  const style = TRAVEL_STYLE[mode];
  const rotation = mode === "flight" ? bearing : 0;
  const size = selected ? 32 : 28;
  return L.divIcon({
    className: "",
    html:
      `<div style="` +
      `background:${style.color};` +
      `width:${size}px;height:${size}px;` +
      `border-radius:50%;` +
      `display:flex;align-items:center;justify-content:center;` +
      `box-shadow:0 1px 4px rgba(0,0,0,.4);` +
      `border:2px solid white;` +
      `transform:rotate(${rotation}deg);` +
      `">${TRAVEL_ICON_SVG[mode]}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// HTML-escape user/agent strings before they go into divIcon HTML. Day tags
// and event titles are agent-authored and could contain markup characters.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Pill that hovers below the travel-mode circle at the midpoint, showing the
// event's title plus auto-derived duration. Anchored so the pill's TOP-CENTER
// sits at the polyline midpoint, then transformed down so it clears the
// circle icon above. Non-interactive — clicks fall through to the underlying
// polyline / travel circle.
function travelTextPillIcon(text: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<div style="` +
      `position:absolute;` +
      `transform:translate(-50%, 22px);` +
      `max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `padding:3px 9px;` +
      `background:rgba(255,255,255,0.95);` +
      `border:1px solid ${color};` +
      `border-radius:9999px;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.12);` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `font-size:11px;` +
      `font-weight:600;` +
      `color:#1f2937;` +
      `pointer-events:none;` +
      `">${escapeHtml(text)}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// Floating "DAY 1 · Friday, May 29" pill that sits above a day's pin cluster.
// Anchored so the pill's BOTTOM-CENTER sits at the cluster centroid, then
// nudged 16px further up so it hovers visibly above the pins below it.
function dayLabelIcon(tag: string | null, dayText: string): L.DivIcon {
  const text = tag ? `${tag} · ${dayText}` : dayText;
  return L.divIcon({
    className: "",
    html:
      `<div style="` +
      `position:absolute;` +
      `transform:translate(-50%, calc(-100% - 16px));` +
      `white-space:nowrap;` +
      `padding:4px 10px;` +
      `background:rgba(255,255,255,0.94);` +
      `border:1px solid #e5e7eb;` +
      `border-radius:9999px;` +
      `box-shadow:0 1px 3px rgba(0,0,0,.10);` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `font-size:10px;` +
      `font-weight:700;` +
      `letter-spacing:0.06em;` +
      `text-transform:uppercase;` +
      `color:#374151;` +
      `pointer-events:none;` +
      `">${escapeHtml(text)}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function renderLayer(layer: MapLayer, idx: number) {
  if (layer.kind === "tile") {
    return (
      <TileLayer
        key={`tile-${idx}`}
        url={layer.url}
        attribution={layer.attribution}
        minZoom={layer.minZoom}
        maxZoom={layer.maxZoom}
        // Smooth out pin-to-pin flyTo: don't thrash tile requests at every
        // intermediate zoom level, keep a wider ring of off-screen tiles so the
        // destination is usually pre-loaded, and reuse parent tiles to fill gaps
        // instead of flashing gray while the new ones arrive.
        updateWhenZooming={false}
        keepBuffer={4}
      />
    );
  }
  return null;
}

// When the Map tab becomes active again after being hidden (display:none),
// the container's pixel size went from 0 → real. Leaflet caches the size,
// so we need to tell it to remeasure or the tiles render at the wrong scale.
function InvalidateOnActive({ active }: { active: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    // Defer one frame so the browser has applied the layout change before
    // Leaflet measures the container.
    const id = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [active, map]);
  return null;
}

// MapController flies the camera to the selected pin and opens its popup.
// When autoFollow is on, also re-fits the view as pins are added.
// Rendered inside <MapContainer> so it can use useMap().
function MapController({
  pins,
  selectedPinId,
  selectedEventId,
  travels,
  autoFollow,
  markerRefs,
}: {
  pins: Pin[];
  selectedPinId: string | null;
  selectedEventId: string | null;
  travels: ResolvedTravel[];
  autoFollow: boolean;
  markerRefs: React.MutableRefObject<Map<string, L.Marker>>;
}) {
  const map = useMap();
  const prevPinIdsRef = useRef<Set<string>>(new Set());
  const prevAutoFollowRef = useRef(autoFollow);

  useEffect(() => {
    if (!selectedPinId) return;
    const pin = pins.find((p) => p.id === selectedPinId);
    if (!pin) return;
    const targetZoom = Math.max(map.getZoom(), 14);
    map.flyTo([pin.lat, pin.lng], targetZoom, { duration: 0.6 });
    // Open the popup once the fly settles. Leaflet ignores openPopup if the
    // marker isn't fully mounted yet, so try shortly after.
    const t = setTimeout(() => {
      markerRefs.current.get(selectedPinId)?.openPopup();
    }, 350);
    return () => clearTimeout(t);
  }, [selectedPinId, pins, map, markerRefs]);

  useEffect(() => {
    if (!selectedEventId) return;
    const travel = travels.find((t) => t.event.id === selectedEventId);
    if (!travel) return;
    const bounds = L.latLngBounds([
      [travel.from.lat, travel.from.lng],
      [travel.to.lat, travel.to.lng],
    ]);
    map.flyToBounds(bounds, { padding: [80, 80], maxZoom: 11, duration: 0.6 });
  }, [selectedEventId, travels, map]);

  useEffect(() => {
    const currentIds = new Set(pins.map((p) => p.id));
    let newPinCount = 0;
    for (const id of currentIds) {
      if (!prevPinIdsRef.current.has(id)) newPinCount++;
    }
    const autoFollowJustTurnedOn = !prevAutoFollowRef.current && autoFollow;
    const shouldRecenter =
      autoFollow && pins.length > 0 && (newPinCount > 0 || autoFollowJustTurnedOn);

    if (shouldRecenter) {
      if (pins.length === 1) {
        const p = pins[0];
        map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
      } else {
        const bounds = L.latLngBounds(
          pins.map((p) => [p.lat, p.lng] as [number, number])
        );
        map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 0.6 });
      }
    }

    prevPinIdsRef.current = currentIds;
    prevAutoFollowRef.current = autoFollow;
  }, [pins, autoFollow, map]);

  return null;
}

const AUTO_FOLLOW_KEY = "tandem.mapMode.autoFollow";

function readAutoFollow(): boolean {
  try {
    const v = localStorage.getItem(AUTO_FOLLOW_KEY);
    if (v == null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

export default function MapMode({
  canvasId,
  mapId,
  state,
  active,
  selectedPinId,
  onSelectPin,
  selectedEventId,
  onSelectEvent,
}: Props) {
  const pins = useMemo(() => Object.values(state.pins), [state.pins]);
  const travels = useMemo<ResolvedTravel[]>(() => {
    const out: ResolvedTravel[] = [];
    for (const ev of Object.values(state.events)) {
      if (!ev.fromPinId || !ev.toPinId || !ev.travelMode) continue;
      const from = state.pins[ev.fromPinId];
      const to = state.pins[ev.toPinId];
      if (!from || !to) continue;
      out.push({ event: ev, from, to, mode: ev.travelMode });
    }
    return out;
  }, [state.events, state.pins]);

  // Floating "DAY 1 · Friday, May 29" labels above each day's pin clusters.
  // Derived from events (no separate group entity) — a pin belongs to the
  // earliest day any event references it on; pins far apart within the same
  // day form separate clusters so labels stay grounded near the actual pins.
  const dayClusters = useMemo(() => buildDayClusters(state), [state]);

  // How many travel legs connect each pin pair (either direction). >1 means a
  // round trip, so we fan those legs to opposite sides instead of overlapping.
  const travelPairCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of travels) {
      const key = pinPairKey(t.from.id, t.to.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [travels]);
  const notesByParent = useMemo(() => {
    const out = new Map<string, typeof state.notes[string][]>();
    for (const n of Object.values(state.notes)) {
      if (!n.parentId) continue;
      const arr = out.get(n.parentId) ?? [];
      arr.push(n);
      out.set(n.parentId, arr);
    }
    return out;
  }, [state.notes]);
  const eventsByPin = useMemo(() => {
    const out = new Map<string, typeof state.events[string][]>();
    for (const ev of Object.values(state.events)) {
      for (const pid of eventPinIds(ev)) {
        const arr = out.get(pid) ?? [];
        arr.push(ev);
        out.set(pid, arr);
      }
    }
    return out;
  }, [state.events]);

  // Sidebar structure: ungrouped pins (referenced by no entry) first, then pins
  // grouped under the itinerary — by day, then entry (event) in time order.
  const { ungrouped, dayGroups } = useMemo(() => {
    const events = Object.values(state.events);
    const referenced = new Set<string>();
    for (const ev of events) {
      for (const id of eventPinIds(ev)) referenced.add(id);
      if (ev.fromPinId) referenced.add(ev.fromPinId);
      if (ev.toPinId) referenced.add(ev.toPinId);
    }
    const ungrouped = pins.filter((p) => !referenced.has(p.id));

    type Entry = { event: CanvasEvent; pins: Pin[] };
    const byDay = new Map<string, Entry[]>();
    for (const ev of events) {
      const evPins: Pin[] =
        ev.travelMode && ev.fromPinId && ev.toPinId
          ? ([state.pins[ev.fromPinId], state.pins[ev.toPinId]].filter(Boolean) as Pin[])
          : (eventPinIds(ev).map((id) => state.pins[id]).filter(Boolean) as Pin[]);
      if (evPins.length === 0) continue;
      const day = dayOf(ev.start, ev.timezone);
      const arr = byDay.get(day) ?? [];
      arr.push({ event: ev, pins: evPins });
      byDay.set(day, arr);
    }
    const dayGroups = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, entries]) => ({
        day,
        entries: entries.sort((x, y) => instantMs(x.event.start) - instantMs(y.event.start)),
      }));
    return { ungrouped, dayGroups };
  }, [pins, state.events, state.pins]);

  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  const [autoFollow, setAutoFollow] = useState<boolean>(() => readAutoFollow());
  useEffect(() => {
    try {
      localStorage.setItem(AUTO_FOLLOW_KEY, autoFollow ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [autoFollow]);

  const dir = useResizablePanel({
    storageKey: "tandem.mapMode.pinDirectory",
    defaultWidth: 288,
    minWidth: 220,
    maxWidth: 480,
    edge: "left",
  });

  const { map, loading, error } = useMapDefinition(mapId ?? "world");

  function handleDragEnd(pin: Pin, e: L.DragEndEvent) {
    const { lat, lng } = (e.target as L.Marker).getLatLng();
    sendOp({ op: "pin.update", id: pin.id, partial: { lat, lng } });
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading map…
      </div>
    );
  }

  if (error || !map) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm">
        <div className="bg-white rounded-xl border border-red-100 px-6 py-4 text-center">
          <p className="text-red-600 font-medium">Couldn't load map</p>
          <p className="text-gray-500 text-xs mt-1">{error?.message ?? "unknown error"}</p>
        </div>
      </div>
    );
  }

  const renderPinRow = (pin: Pin, indent = false) => {
    const notes = notesByParent.get(pin.id) ?? [];
    const isSelected = pin.id === selectedPinId;
    const preview =
      pin.body?.split("\n").find((l) => l.trim()) ??
      notes[0]?.body.split("\n").find((l) => l.trim()) ??
      null;
    return (
      <li key={pin.id}>
        <button
          onClick={() => onSelectPin(pin.id)}
          className={[
            "w-full text-left py-2.5 transition-colors",
            indent ? "pl-8 pr-4" : "px-4",
            isSelected ? "bg-blue-50" : "hover:bg-gray-50",
          ].join(" ")}
        >
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: pin.color ?? "#3b82f6" }}
            />
            <span className="font-medium text-sm text-gray-900 truncate">
              {pin.label ?? "Pin"}
            </span>
          </div>
          {preview && (
            <p className="mt-1 text-xs text-gray-500 line-clamp-2 pl-[18px]">{preview}</p>
          )}
          {notes.length > 0 && (
            <div className="mt-1 text-[10px] text-gray-400 pl-[18px]">
              {notes.length} note{notes.length === 1 ? "" : "s"}
            </div>
          )}
        </button>
      </li>
    );
  };

  const center: [number, number] =
    pins.length > 0
      ? [
          pins.reduce((s, p) => s + p.lat, 0) / pins.length,
          pins.reduce((s, p) => s + p.lng, 0) / pins.length,
        ]
      : map.center;
  const zoom = pins.length > 0 ? Math.max(map.zoom, 11) : map.zoom;

  return (
    <div className="flex flex-1 min-h-0">
      {/* Map */}
      <div className="flex-1 relative">
        <MapContainer
          center={center}
          zoom={zoom}
          minZoom={map.minZoom}
          maxZoom={map.maxZoom}
          className="h-full w-full"
        >
          {map.layers.map(renderLayer)}
          <InvalidateOnActive active={active} />
          <MapController
            pins={pins}
            selectedPinId={selectedPinId}
            selectedEventId={selectedEventId}
            travels={travels}
            autoFollow={autoFollow}
            markerRefs={markerRefs}
          />
          {travels.map((t) => {
            const from: LatLng = [t.from.lat, t.from.lng];
            const to: LatLng = [t.to.lat, t.to.lng];
            const separate = (travelPairCounts.get(pinPairKey(t.from.id, t.to.id)) ?? 0) > 1;
            const path = travelPath(from, to, t.mode, separate);
            const mid = travelMidpoint(from, to, t.mode, separate);
            const bearing = travelBearing(from, to);
            const style = TRAVEL_STYLE[t.mode];
            const selected = t.event.id === selectedEventId;
            // Pill below the travel circle: agent-authored title + auto duration.
            const durationMs = t.event.end
              ? instantMs(t.event.end) - instantMs(t.event.start)
              : 0;
            const pillText = durationMs > 0
              ? `${t.event.title} · ${formatDuration(durationMs)}`
              : t.event.title;
            return (
              <Fragment key={t.event.id}>
                <Polyline
                  positions={path}
                  pathOptions={{
                    color: style.color,
                    weight: selected ? 4 : 3,
                    opacity: 0.9,
                    dashArray: style.dashArray,
                  }}
                  eventHandlers={{
                    click: () => onSelectEvent(t.event.id),
                  }}
                />
                <Marker
                  position={mid}
                  icon={travelIcon(t.mode, bearing, selected)}
                  interactive
                  eventHandlers={{
                    click: () => onSelectEvent(t.event.id),
                  }}
                />
                <Marker
                  position={mid}
                  icon={travelTextPillIcon(pillText, style.color)}
                  interactive={false}
                  zIndexOffset={-200}
                />
              </Fragment>
            );
          })}
          {dayClusters.map((c) => (
            <Marker
              key={`day-${c.dayKey}-${c.pinIds.join(",")}`}
              position={c.centroid}
              icon={dayLabelIcon(c.dayTag, formatDay(c.dayKey))}
              interactive={false}
              zIndexOffset={-500}
            />
          ))}
          {pins.map((pin) => {
            const eventCount = eventsByPin.get(pin.id)?.length ?? 0;
            const icon =
              pin.color || eventCount > 0
                ? L.divIcon({
                    className: "",
                    html: `<div style="
                      background:${pin.color ?? "#3b82f6"};
                      color:white;
                      border-radius:50%;
                      width:28px;height:28px;
                      display:flex;align-items:center;justify-content:center;
                      font-size:11px;font-weight:600;
                      box-shadow:0 1px 4px rgba(0,0,0,.4);
                      border:2px solid white;
                    ">${eventCount > 0 ? eventCount : ""}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14],
                  })
                : new L.Icon.Default();

            const notes = notesByParent.get(pin.id) ?? [];
            const events = eventsByPin.get(pin.id) ?? [];

            return (
              <Marker
                key={pin.id}
                position={[pin.lat, pin.lng]}
                icon={icon}
                draggable
                ref={(m) => {
                  if (m) markerRefs.current.set(pin.id, m);
                  else markerRefs.current.delete(pin.id);
                }}
                eventHandlers={{
                  click: () => onSelectPin(pin.id),
                  dragend: (e) => handleDragEnd(pin, e as unknown as L.DragEndEvent),
                  popupclose: () => {
                    // Don't clear selection on close — directory keeps highlighting.
                  },
                }}
              >
                <Popup maxWidth={320} minWidth={220} autoPan>
                  <div className="space-y-2">
                    {pin.label && (
                      <div className="font-semibold text-gray-900">{pin.label}</div>
                    )}
                    {pin.body && (
                      <div className="text-sm text-gray-700 prose prose-sm max-w-none">
                        <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                          {pin.body}
                        </ReactMarkdown>
                      </div>
                    )}

                    {events.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mt-1">
                          Events
                        </div>
                        <ul className="text-xs text-gray-700 space-y-0.5">
                          {events.map((ev) => (
                            <li key={ev.id}>
                              <span className="font-medium">{ev.title}</span>
                              <span className="text-gray-400 ml-1">
                                {new Date(ev.start).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  timeZone: ev.timezone || undefined,
                                })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {notes.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mt-1">
                          Notes
                        </div>
                        <div className="space-y-2">
                          {notes.map((note) => (
                            <div
                              key={note.id}
                              className="text-xs text-gray-700 prose prose-sm max-w-none"
                            >
                              <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                                {note.body}
                              </ReactMarkdown>
                              {note.imageRefs.map((ref) => (
                                <img
                                  key={ref}
                                  src={imageUrl(canvasId, ref)}
                                  alt=""
                                  className="mt-1 rounded max-w-full"
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!pin.body && notes.length === 0 && events.length === 0 && (
                      <p className="text-xs text-gray-400">No details yet.</p>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>

        {pins.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/90 rounded-xl px-6 py-4 text-center shadow text-gray-500 text-sm">
              <div className="font-medium text-gray-700">{map.name}</div>
              <div className="text-xs mt-1">Ask Claude to add locations.</div>
            </div>
          </div>
        )}

        {/* Top-right controls: auto-center toggle + pin directory reveal */}
        <div className="absolute top-3 right-3 z-[400] flex items-center gap-2">
          <button
            onClick={() => setAutoFollow((v) => !v)}
            aria-label={autoFollow ? "Disable auto-center" : "Enable auto-center"}
            aria-pressed={autoFollow}
            title={
              autoFollow
                ? "Auto-center on — camera fits all pins as they're added"
                : "Auto-center off — camera stays put"
            }
            className={[
              "flex items-center justify-center w-9 h-9 rounded-lg border shadow-sm transition-colors",
              autoFollow
                ? "bg-blue-500 text-white border-blue-500 hover:bg-blue-600"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
            ].join(" ")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
          </button>

          {pins.length > 0 && dir.collapsed && (
            <button
              onClick={() => dir.setCollapsed(false)}
              aria-label="Show pin directory"
              title="Show pins"
              className="flex items-center gap-1.5 bg-white hover:bg-gray-50 border border-gray-200 shadow-sm rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-700"
            >
              <span aria-hidden>‹</span>
              <span>Pins</span>
              <span className="text-gray-400">{pins.length}</span>
            </button>
          )}
        </div>
      </div>

      {/* Pin directory (resizable + collapsible) */}
      {pins.length > 0 && !dir.collapsed && (
        <aside
          style={{ width: dir.width }}
          className="relative shrink-0 border-l border-gray-200 bg-white flex flex-col overflow-hidden"
        >
          {/* Drag handle on the LEFT edge of the right-docked panel */}
          <div
            {...dir.handleProps}
            aria-label="Resize pin directory"
            className={[
              "absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 z-10 cursor-col-resize",
              "hover:bg-blue-400/40 active:bg-blue-500/60 transition-colors",
              dir.resizing ? "bg-blue-500/60" : "",
            ].join(" ")}
          />

          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-gray-900 text-sm">Pins</h2>
              <span className="text-xs text-gray-400">{pins.length}</span>
            </div>
            <button
              onClick={() => dir.setCollapsed(true)}
              aria-label="Hide pin directory"
              title="Hide"
              className="text-gray-400 hover:text-gray-600 px-1"
            >
              <span aria-hidden>›</span>
            </button>
          </div>

          <div
            className={[
              "flex-1 overflow-y-auto",
              dir.resizing ? "select-none" : "",
            ].join(" ")}
          >
            {ungrouped.length > 0 && (
              <div>
                {dayGroups.length > 0 && (
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Ungrouped <span className="text-gray-300">· {ungrouped.length}</span>
                  </div>
                )}
                <ul className="divide-y divide-gray-50">
                  {ungrouped.map((p) => renderPinRow(p))}
                </ul>
              </div>
            )}

            {dayGroups.map(({ day, entries }) => (
              <div key={day}>
                <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-t border-gray-100">
                  {formatDay(day)}
                </div>
                {entries.map(({ event, pins: entryPins }) => (
                  <div key={event.id}>
                    <div className="px-4 pt-1.5 pb-0.5 flex items-baseline gap-2">
                      <span className="text-xs font-medium text-gray-700 truncate">
                        {event.title}
                      </span>
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {formatTime(event.start, event.timezone)}
                      </span>
                    </div>
                    <ul className="divide-y divide-gray-50">
                      {entryPins.map((p) => renderPinRow(p, true))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
