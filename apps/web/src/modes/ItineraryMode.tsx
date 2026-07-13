import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plane, TrainFront, Car, Trash2, Plus, Check } from "lucide-react";
import type { CanvasState, CanvasEvent, TravelMode } from "../types";
import { sendOp } from "../lib/ws";
import EmptyState from "../components/EmptyState";
import {
  instantMs,
  formatTime,
  formatDay,
  dayOf,
  tzAbbrev,
  instantToLocalInput,
  localInputToInstant,
} from "../lib/itineraryTime";
import { eventPinIds } from "../lib/eventPins";

interface Props {
  state: CanvasState;
  canvasCode: string;
  canvasName: string;
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

// Trip costs are derived live from events, so the total always tracks the plan.
const MONEY = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const formatCost = (n: number) => MONEY.format(n);
const sumCost = (events: CanvasEvent[]) =>
  events.reduce((total, ev) => total + (typeof ev.cost === "number" ? ev.cost : 0), 0);

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

const updateEvent = (
  id: string,
  partial: Partial<CanvasEvent> & { clearEnd?: boolean; clearCost?: boolean },
) => sendOp({ op: "event.update", id, partial });

// Create a new event. `dayKey` (YYYY-MM-DD) + `tz` seed the start at noon that
// day so it lands in the right day-group; without one we default to right now.
function addEvent(dayKey?: string, tz?: string) {
  const start = dayKey
    ? localInputToInstant(`${dayKey}T12:00`, tz)
    : new Date().toISOString();
  sendOp({
    op: "event.add",
    data: { title: "New event", start, ...(tz ? { timezone: tz } : {}) },
  });
}

export default function ItineraryMode({
  state,
  canvasCode,
  canvasName,
  selectedEventId,
  onSelectEvent,
}: Props) {
  const events = Object.values(state.events);
  const days = groupByDay(events);
  // Live grand total across the whole itinerary. Editing any event's cost (or
  // adding/removing one) recomputes this on the next render — no sheet to sync.
  const grandTotal = sumCost(events);
  const hasCost = events.some((ev) => typeof ev.cost === "number");

  // Export URL doubles as a download (Content-Disposition forces it) AND a
  // calendar subscription URL (Google / Apple / Outlook can poll it). Same URL,
  // two uses.
  const icsPath = `/api/canvas/${canvasCode}/itinerary.ics`;
  const icsAbsoluteUrl =
    typeof window !== "undefined" ? `${window.location.origin}${icsPath}` : icsPath;
  const downloadFilename = (canvasName || "itinerary").replace(/[^\w\- .]/g, "_") + ".ics";

  const [copied, setCopied] = useState(false);
  function copySubscribeUrl() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(icsAbsoluteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        hint="Click a day to add an event, ask your agent to plan the trip, or pick a template."
        action={{ label: "+ Add event", onClick: () => addEvent() }}
      />
    );
  }

  return (
    <div className="tandem-scroll flex-1 overflow-y-auto bg-paper">
      <div className="max-w-2xl mx-auto w-full px-6 py-6">
        <div className="flex items-center justify-between gap-3 mb-4 -mt-2">
          {hasCost ? (
            <span className="text-sm font-medium text-ink">
              Total <span className="text-emerald-600">{formatCost(grandTotal)}</span>
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
          <a
            href={icsPath}
            download={downloadFilename}
            className="text-xs text-ink/55 hover:text-ink/80 underline underline-offset-2"
            title="Download a one-time .ics file. Import into Google / Apple / Outlook calendar."
          >
            Download .ics
          </a>
          <button
            onClick={copySubscribeUrl}
            className="text-xs text-ink/55 hover:text-ink/80 underline underline-offset-2"
            title="Copy a calendar subscription URL. Paste into Google Calendar → Other calendars → From URL — the trip will stay in sync as you edit Tandem."
          >
            {copied ? "Copied!" : "Copy subscribe URL"}
          </button>
          </div>
        </div>
        {days.map(([day, dayEvents]) => {
          // New events on this day inherit its zone so they slot into the group.
          const dayTz = dayEvents.find((e) => e.timezone)?.timezone;
          return (
          <section key={day} className="mb-8">
            <h2 className="font-display text-lg font-medium tracking-tight text-ink mb-3 sticky top-0 bg-paper/90 backdrop-blur py-1.5 z-10 flex items-baseline justify-between gap-3">
              <span>{formatDay(day)}</span>
              {sumCost(dayEvents) > 0 && (
                <span className="text-sm font-normal text-ink/40">{formatCost(sumCost(dayEvents))}</span>
              )}
            </h2>
            <div className="space-y-3">
              {dayEvents.map((ev) => (
                <EventCard
                  key={ev.id}
                  ev={ev}
                  state={state}
                  isSelected={ev.id === selectedEventId}
                  onSelect={() =>
                    onSelectEvent(ev.id === selectedEventId ? null : ev.id)
                  }
                />
              ))}
              <button
                onClick={() => addEvent(day, dayTz)}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink/15 py-2 text-xs font-medium text-ink/40 hover:border-ink/20 hover:text-ink/60 transition-colors"
              >
                <Plus size={13} /> Add event
              </button>
            </div>
          </section>
          );
        })}
      </div>
    </div>
  );
}

function EventCard({
  ev,
  state,
  isSelected,
  onSelect,
}: {
  ev: CanvasEvent;
  state: CanvasState;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const eventPins = eventPinIds(ev)
    .map((id) => state.pins[id])
    .filter(Boolean);
  const fromPin = ev.fromPinId ? state.pins[ev.fromPinId] : null;
  const toPin = ev.toPinId ? state.pins[ev.toPinId] : null;
  const isTravel = !!(ev.travelMode && fromPin && toPin);
  const travelStyle = ev.travelMode ? TRAVEL_STYLE[ev.travelMode] : null;
  const notes = Object.values(state.notes).filter((n) => n.parentId === ev.id);

  const [editingTime, setEditingTime] = useState(false);

  return (
    <div
      data-agent-target={ev.id}
      onClick={onSelect}
      className={[
        "group/ev relative bg-surface rounded-lg border p-4 cursor-pointer transition-colors",
        isSelected ? "border-ink/20 ring-1 ring-ink/15" : "border-ink/15 hover:border-ink/20",
      ].join(" ")}
      style={isTravel && travelStyle ? { borderLeft: `4px solid ${travelStyle.color}` } : undefined}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm("Delete this event?")) sendOp({ op: "event.delete", id: ev.id });
        }}
        title="Delete event"
        className="absolute top-2 right-2 z-10 opacity-0 group-hover/ev:opacity-100 text-ink/30 hover:text-red-600 transition-opacity p-1"
      >
        <Trash2 size={14} />
      </button>

      <div className="flex items-start justify-between gap-2 pr-6">
        <InlineText
          value={ev.title}
          placeholder="Untitled event"
          onCommit={(title) => title !== ev.title && updateEvent(ev.id, { title })}
          className="font-medium text-ink"
        />
        <span className="flex flex-col items-end shrink-0">
          {editingTime ? (
            <TimeEditor ev={ev} onClose={() => setEditingTime(false)} />
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingTime(true);
              }}
              className="text-sm text-ink/40 hover:text-ink/70 whitespace-nowrap rounded px-1 -mr-1 hover:bg-ink/5"
              title="Edit time"
            >
              {formatTime(ev.start, ev.timezone)}
              {ev.end && ` – ${formatTime(ev.end, ev.timezone)}`}
              {tzAbbrev(ev.start, ev.timezone) && (
                <span className="ml-1 text-ink/30">{tzAbbrev(ev.start, ev.timezone)}</span>
              )}
            </button>
          )}
          <CostField ev={ev} />
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
              className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 bg-amber-500/10 text-amber-600"
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
        <div className="mt-3 space-y-2 border-t border-ink/10 pt-3">
          {notes.map((note) => (
            <div
              key={note.id}
              className="text-sm text-ink/60 prose prose-sm max-w-none"
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
}

// Click-to-edit single-line text. Commits on blur / Enter, reverts on Escape.
// stopPropagation keeps the click from toggling the card's selection.
function InlineText({
  value,
  placeholder,
  onCommit,
  className = "",
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onCommit(next);
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        className={`${className} bg-transparent rounded px-1 -mx-1 outline-none min-w-0 w-full caret-ink`}
      />
    );
  }

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={`${className} cursor-text rounded px-1 -mx-1 hover:bg-ink/5 ${
        value ? "" : "text-ink/40 italic"
      }`}
    >
      {value || placeholder}
    </span>
  );
}

// Cost is click-to-edit; when unset a faint "+ cost" affordance appears on hover.
function CostField({ ev }: { ev: CanvasEvent }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    typeof ev.cost === "number" ? String(ev.cost) : ""
  );
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(typeof ev.cost === "number" ? String(ev.cost) : "");
  }, [ev.cost]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (typeof ev.cost === "number") updateEvent(ev.id, { clearCost: true });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isNaN(n) && n !== ev.cost) updateEvent(ev.id, { cost: n });
  }

  if (editing) {
    return (
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        value={draft}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="0"
        className="mt-0.5 w-20 text-right text-xs font-semibold text-emerald-600 bg-transparent rounded px-1 outline-none caret-emerald-600"
      />
    );
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={
        typeof ev.cost === "number"
          ? "mt-0.5 text-xs font-semibold text-emerald-600 whitespace-nowrap rounded px-1 -mr-1 hover:bg-emerald-500/10"
          : "mt-0.5 text-xs font-medium text-ink/30 opacity-0 group-hover/ev:opacity-100 hover:text-emerald-600 rounded px-1 -mr-1 transition-opacity"
      }
      title="Edit cost"
    >
      {typeof ev.cost === "number" ? formatCost(ev.cost) : "+ cost"}
    </button>
  );
}

// Inline start/end editor. Each field commits independently (blur/Enter) so
// there's no save button; the check button just closes the editor.
function TimeEditor({ ev, onClose }: { ev: CanvasEvent; onClose: () => void }) {
  const [start, setStart] = useState(instantToLocalInput(ev.start, ev.timezone));
  const [end, setEnd] = useState(
    ev.end ? instantToLocalInput(ev.end, ev.timezone) : ""
  );

  function commitStart() {
    if (!start) return;
    const iso = localInputToInstant(start, ev.timezone);
    if (iso !== ev.start) updateEvent(ev.id, { start: iso });
  }
  function commitEnd() {
    if (end === "") {
      if (ev.end) updateEvent(ev.id, { clearEnd: true });
      return;
    }
    const iso = localInputToInstant(end, ev.timezone);
    if (iso !== ev.end) updateEvent(ev.id, { end: iso });
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col items-end gap-1"
    >
      <div className="flex items-center gap-1">
        <input
          type="datetime-local"
          value={start}
          autoFocus
          onChange={(e) => setStart(e.target.value)}
          onBlur={commitStart}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitStart(); onClose(); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          className="text-xs text-ink/70 bg-blue-500/10 rounded px-1 outline-none ring-1 ring-blue-400/40"
        />
        <button
          onClick={() => { commitStart(); commitEnd(); onClose(); }}
          title="Done"
          className="text-emerald-600 hover:text-emerald-700 p-0.5"
        >
          <Check size={14} />
        </button>
      </div>
      <input
        type="datetime-local"
        value={end}
        placeholder="end (optional)"
        onChange={(e) => setEnd(e.target.value)}
        onBlur={commitEnd}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commitEnd(); onClose(); }
          else if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        className="text-xs text-ink/55 bg-surface rounded px-1 outline-none ring-1 ring-ink/15"
      />
    </div>
  );
}
