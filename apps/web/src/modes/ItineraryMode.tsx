import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plane, TrainFront, Car } from "lucide-react";
import type { CanvasState, CanvasEvent, TravelMode } from "../types";
import EmptyState from "../components/EmptyState";

interface Props {
  state: CanvasState;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}

const TRAVEL_STYLE: Record<TravelMode, { color: string; label: string }> = {
  flight: { color: "#3b82f6", label: "Flight" },
  train:  { color: "#10b981", label: "Train" },
  drive:  { color: "#f59e0b", label: "Drive" },
};

function TravelIcon({ mode, className }: { mode: TravelMode; className?: string }) {
  const props = { size: 14, strokeWidth: 2.5, className };
  if (mode === "flight") return <Plane {...props} />;
  if (mode === "train") return <TrainFront {...props} />;
  return <Car {...props} />;
}

const MARKDOWN_PLUGINS = [remarkGfm];

function formatTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDay(dayStr: string) {
  const d = new Date(dayStr + "T00:00:00");
  if (isNaN(d.getTime())) return dayStr;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function groupByDay(events: CanvasEvent[]): [string, CanvasEvent[]][] {
  const map = new Map<string, CanvasEvent[]>();
  for (const ev of events) {
    const day = ev.start.split("T")[0] ?? ev.start;
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(ev);
  }
  for (const evts of map.values()) {
    evts.sort((a, b) => a.start.localeCompare(b.start));
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export default function ItineraryMode({ state, selectedEventId, onSelectEvent }: Props) {
  const events = Object.values(state.events);
  const days = groupByDay(events);

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        hint="Ask Claude to plan your itinerary, or pick a different template."
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 max-w-2xl mx-auto w-full">
      {days.map(([day, dayEvents]) => (
        <section key={day} className="mb-8">
          <h2 className="text-base font-semibold text-gray-900 mb-3 sticky top-0 bg-gray-50 py-1">
            {formatDay(day)}
          </h2>
          <div className="space-y-3">
            {dayEvents.map((ev) => {
              const pin = ev.pinId ? state.pins[ev.pinId] : null;
              const fromPin = ev.fromPinId ? state.pins[ev.fromPinId] : null;
              const toPin = ev.toPinId ? state.pins[ev.toPinId] : null;
              const isTravel = !!(ev.travelMode && fromPin && toPin);
              const travelStyle = ev.travelMode ? TRAVEL_STYLE[ev.travelMode] : null;
              const notes = Object.values(state.notes).filter(
                (n) => n.parentId === ev.id
              );
              const isSelected = ev.id === selectedEventId;
              return (
                <div
                  key={ev.id}
                  onClick={() => onSelectEvent(isSelected ? null : ev.id)}
                  className={[
                    "bg-white rounded-lg border p-4 cursor-pointer transition-colors",
                    isSelected ? "border-gray-300 ring-1 ring-gray-200" : "border-gray-200 hover:border-gray-300",
                  ].join(" ")}
                  style={isTravel && travelStyle ? { borderLeft: `4px solid ${travelStyle.color}` } : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-gray-900">{ev.title}</span>
                    <span className="text-sm text-gray-400 whitespace-nowrap">
                      {formatTime(ev.start)}
                      {ev.end && ` – ${formatTime(ev.end)}`}
                    </span>
                  </div>

                  {isTravel && travelStyle && (
                    <div
                      className="inline-flex items-center gap-1.5 mt-1.5 text-xs font-medium rounded-full px-2 py-0.5"
                      style={{
                        background: `${travelStyle.color}1a`,
                        color: travelStyle.color,
                      }}
                    >
                      <TravelIcon mode={ev.travelMode!} />
                      <span>{fromPin!.label ?? "Origin"}</span>
                      <span aria-hidden>→</span>
                      <span>{toPin!.label ?? "Destination"}</span>
                    </div>
                  )}

                  {!isTravel && pin && (
                    <span className="inline-block mt-1.5 text-xs bg-blue-50 text-blue-700 rounded-full px-2 py-0.5">
                      {pin.label ?? "Pin"}
                    </span>
                  )}

                  {notes.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
                      {notes.map((note) => (
                        <div
                          key={note.id}
                          className="text-sm text-gray-600 prose prose-sm max-w-none"
                        >
                          <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                            {note.body}
                          </ReactMarkdown>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
