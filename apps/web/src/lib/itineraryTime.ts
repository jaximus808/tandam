// Events store a true UTC instant (`start`). We render and day-group each event
// in ITS location's IANA timezone (event.timezone) so a cross-timezone trip
// shows every stop in its own local time. When timezone is absent we fall back
// to the viewer's local zone (Intl default).

export function instantMs(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Clock time of the instant, in the given zone (e.g. "12:30 PM").
export function formatTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz || undefined,
  }).format(d);
}

// Calendar date (YYYY-MM-DD) of the instant in the given zone — the day-group
// key. en-CA formats as YYYY-MM-DD, and timeZone makes it the local date there.
export function dayOf(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.split("T")[0] ?? iso;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz || undefined,
  }).format(d);
}

// Short zone label for the instant (e.g. "CDT", "JST"). Null when no zone given.
export function tzAbbrev(iso: string, tz?: string): string | null {
  if (!tz) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    timeZoneName: "short",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? null;
}

// --- Inline editing helpers ---------------------------------------------
// Editing a time in the itinerary means round-tripping a `<input type="datetime-local">`
// value (a "wall clock" with no zone) against the event's stored UTC instant +
// IANA timezone. These two functions are inverses.

// Offset (ms) of `tz` from UTC at a given instant — positive east of UTC.
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === "24" ? "00" : m.hour; // some engines emit 24 for midnight
  const asUTC = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(hour),
    Number(m.minute),
    Number(m.second),
  );
  return asUTC - utcMs;
}

// UTC instant → the wall-clock string ("YYYY-MM-DDTHH:mm") a datetime-local input
// wants, expressed in the event's zone (or the viewer's zone when tz is absent).
export function instantToLocalInput(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!tz) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === "24" ? "00" : m.hour;
  return `${m.year}-${m.month}-${m.day}T${hour}:${m.minute}`;
}

// Inverse: a datetime-local wall-clock string, interpreted as being in `tz`,
// back to a true UTC instant (ISO). Refines once so DST boundaries land right.
export function localInputToInstant(local: string, tz?: string): string {
  if (!local) return local;
  if (!tz) return new Date(local).toISOString();
  const naiveUTC = Date.parse(local.length === 16 ? `${local}:00Z` : `${local}Z`);
  if (Number.isNaN(naiveUTC)) return new Date(local).toISOString();
  const offset = tzOffsetMs(naiveUTC, tz);
  let guess = naiveUTC - offset;
  const offset2 = tzOffsetMs(guess, tz);
  if (offset2 !== offset) guess = naiveUTC - offset2;
  return new Date(guess).toISOString();
}

// Human day header from a YYYY-MM-DD key. Built from explicit Y/M/D so the
// weekday isn't shifted by the viewer's zone (a bare yyyy-mm-dd parses as UTC
// and can land on the previous day in western timezones).
export function formatDay(dayStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayStr);
  if (!m) return dayStr;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return dayStr;
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
