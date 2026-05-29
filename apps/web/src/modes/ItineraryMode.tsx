import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plane, TrainFront, Car } from "lucide-react";
import type { CanvasState, CanvasEvent, TravelMode } from "../types";
import EmptyState from "../components/EmptyState";
import { instantMs, formatTime, formatDay, dayOf, tzAbbrev } from "../lib/itineraryTime";
import { eventPinIds } from "../lib/eventPins";

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

function groupByDay(events: CanvasEvent[]): [string, CanvasEvent[]][] {
  const map = new Map<string, CanvasEvent[]>();
  for (const ev of events) {
    const day = dayOf(ev.start, ev.timezone);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(ev);
  }
  for (const evts of map.values()) {
    evts.sort((a, b) => instantMs(a.start) - instantMs(b.start));
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
        hint="Ask your agent to plan your itinerary, or pick a different template."
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full px-6 py-6">
        {days.map(([day, dayEvents]) => (
        <section key={day} className="mb-8">
          <h2 className="text-base font-semibold text-gray-900 mb-3 sticky top-0 bg-gray-50 py-1">
            {formatDay(day)}
          </h2>
          <div className="space-y-3">
            {dayEvents.map((ev) => {
              const eventPins = eventPinIds(ev)
                .map((id) => state.pins[id])
                .filter(Boolean);
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
                      {formatTime(ev.start, ev.timezone)}
                      {ev.end && ` – ${formatTime(ev.end, ev.timezone)}`}
                      {tzAbbrev(ev.start, ev.timezone) && (
                        <span className="ml-1 text-gray-300">{tzAbbrev(ev.start, ev.timezone)}</span>
                      )}
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

                  {!isTravel && eventPins.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {eventPins.map((p) => (
                        <span
                          key={p!.id}
                          className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 rounded-full px-2 py-0.5"
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: p!.color ?? "#3b82f6" }}
                          />
                          {p!.label ?? "Pin"}
                        </span>
                      ))}
                    </div>
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
    </div>
  );
}
