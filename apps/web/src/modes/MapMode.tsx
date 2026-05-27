import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasState, Pin } from "../types";
import { sendOp } from "../lib/ws";
import { imageUrl } from "../lib/api";

const MARKDOWN_PLUGINS = [remarkGfm];
import { useMapDefinition } from "../lib/useMapDefinition";
import type { MapLayer } from "../lib/maps";
import { useResizablePanel } from "../lib/useResizablePanel";

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
  autoFollow,
  markerRefs,
}: {
  pins: Pin[];
  selectedPinId: string | null;
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
}: Props) {
  const pins = useMemo(() => Object.values(state.pins), [state.pins]);
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
      if (!ev.pinId) continue;
      const arr = out.get(ev.pinId) ?? [];
      arr.push(ev);
      out.set(ev.pinId, arr);
    }
    return out;
  }, [state.events]);

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
            autoFollow={autoFollow}
            markerRefs={markerRefs}
          />
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

          <ul
            className={[
              "flex-1 overflow-y-auto divide-y divide-gray-50",
              dir.resizing ? "select-none" : "",
            ].join(" ")}
          >
            {pins.map((pin) => {
              const notes = notesByParent.get(pin.id) ?? [];
              const events = eventsByPin.get(pin.id) ?? [];
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
                      "w-full text-left px-4 py-2.5 transition-colors",
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
                      <p className="mt-1 text-xs text-gray-500 line-clamp-2 pl-[18px]">
                        {preview}
                      </p>
                    )}
                    {(notes.length > 0 || events.length > 0) && (
                      <div className="mt-1 flex gap-2 text-[10px] text-gray-400 pl-[18px]">
                        {notes.length > 0 && <span>{notes.length} note{notes.length === 1 ? "" : "s"}</span>}
                        {events.length > 0 && <span>{events.length} event{events.length === 1 ? "" : "s"}</span>}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}
    </div>
  );
}
