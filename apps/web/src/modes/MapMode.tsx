import { useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import ReactMarkdown from "react-markdown";
import type { CanvasState, PendingEdit, Pin } from "../types";
import { sendOp } from "../lib/ws";
import ScopedEdit from "../components/ScopedEdit";
import { imageUrl } from "../lib/api";

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
  state: CanvasState;
  pendingEdits: PendingEdit[];
  selectedPinId: string | null;
  onSelectPin: (id: string | null) => void;
}

export default function MapMode({ canvasId, state, pendingEdits, selectedPinId, onSelectPin }: Props) {
  const pins = Object.values(state.pins);
  const selectedPin = selectedPinId ? state.pins[selectedPinId] : null;
  const attachedNotes = selectedPin
    ? Object.values(state.notes).filter((n) => n.parentId === selectedPin.id)
    : [];
  const linkedEvents = selectedPin
    ? Object.values(state.events).filter((e) => e.pinId === selectedPin.id)
    : [];

  const center: [number, number] =
    pins.length > 0
      ? [
          pins.reduce((s, p) => s + p.lat, 0) / pins.length,
          pins.reduce((s, p) => s + p.lng, 0) / pins.length,
        ]
      : [35.6762, 139.6503]; // Tokyo default

  function handleDragEnd(pin: Pin, e: L.DragEndEvent) {
    const { lat, lng } = (e.target as L.Marker).getLatLng();
    sendOp({ op: "pin.update", id: pin.id, partial: { lat, lng } });
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* Map */}
      <div className="flex-1 relative">
        <MapContainer center={center} zoom={13} className="h-full w-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {pins.map((pin) => {
            const eventCount = Object.values(state.events).filter(
              (e) => e.pinId === pin.id
            ).length;
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

            return (
              <Marker
                key={pin.id}
                position={[pin.lat, pin.lng]}
                icon={icon}
                draggable
                eventHandlers={{
                  click: () => onSelectPin(pin.id),
                  dragend: (e) => handleDragEnd(pin, e as unknown as L.DragEndEvent),
                }}
              >
                {pin.label && (
                  <Popup>
                    <span className="font-medium">{pin.label}</span>
                  </Popup>
                )}
              </Marker>
            );
          })}
        </MapContainer>

        {pins.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/90 rounded-xl px-6 py-4 text-center shadow text-gray-500 text-sm">
              Ask Claude to add locations to get started.
            </div>
          </div>
        )}
      </div>

      {/* Side panel */}
      {selectedPin && (
        <aside className="w-80 border-l border-gray-200 bg-white flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 truncate">
              {selectedPin.label ?? "Pin"}
            </h2>
            <button
              onClick={() => onSelectPin(null)}
              className="text-gray-400 hover:text-gray-600 ml-2"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Pin details */}
            {selectedPin.body && (
              <ScopedEdit entityId={selectedPin.id} pendingEdits={pendingEdits}>
                <div className="text-sm text-gray-700 prose prose-sm max-w-none">
                  <ReactMarkdown>{selectedPin.body}</ReactMarkdown>
                </div>
              </ScopedEdit>
            )}

            {/* Linked events */}
            {linkedEvents.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Events
                </h3>
                <ul className="space-y-1">
                  {linkedEvents.map((ev) => (
                    <li key={ev.id} className="text-sm text-gray-700">
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

            {/* Attached notes */}
            {attachedNotes.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Notes
                </h3>
                <div className="space-y-3">
                  {attachedNotes.map((note) => (
                    <ScopedEdit key={note.id} entityId={note.id} pendingEdits={pendingEdits}>
                      <div className="text-sm text-gray-700 prose prose-sm max-w-none">
                        <ReactMarkdown>{note.body}</ReactMarkdown>
                        {note.imageRefs.map((ref) => (
                          <img
                            key={ref}
                            src={imageUrl(canvasId, ref)}
                            alt=""
                            className="mt-1 rounded max-w-full"
                          />
                        ))}
                      </div>
                    </ScopedEdit>
                  ))}
                </div>
              </div>
            )}

            {attachedNotes.length === 0 && linkedEvents.length === 0 && !selectedPin.body && (
              <p className="text-sm text-gray-400">No details yet.</p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
