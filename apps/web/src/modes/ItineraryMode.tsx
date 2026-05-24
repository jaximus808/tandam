import ReactMarkdown from "react-markdown";
import type { CanvasState, PendingEdit, CanvasEvent } from "../types";
import ScopedEdit from "../components/ScopedEdit";

interface Props {
  state: CanvasState;
  pendingEdits: PendingEdit[];
}

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

export default function ItineraryMode({ state, pendingEdits }: Props) {
  const events = Object.values(state.events);
  const days = groupByDay(events);

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        No events yet — ask Claude to plan your itinerary.
      </div>
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
              const notes = Object.values(state.notes).filter(
                (n) => n.parentId === ev.id
              );
              return (
                <div key={ev.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <ScopedEdit entityId={ev.id} pendingEdits={pendingEdits}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-gray-900">{ev.title}</span>
                      <span className="text-sm text-gray-400 whitespace-nowrap">
                        {formatTime(ev.start)}
                        {ev.end && ` – ${formatTime(ev.end)}`}
                      </span>
                    </div>
                    {pin && (
                      <span className="inline-block mt-1.5 text-xs bg-blue-50 text-blue-700 rounded-full px-2 py-0.5">
                        📍 {pin.label ?? "Pin"}
                      </span>
                    )}
                  </ScopedEdit>

                  {notes.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
                      {notes.map((note) => (
                        <ScopedEdit key={note.id} entityId={note.id} pendingEdits={pendingEdits}>
                          <div className="text-sm text-gray-600 prose prose-sm max-w-none">
                            <ReactMarkdown>{note.body}</ReactMarkdown>
                          </div>
                        </ScopedEdit>
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
