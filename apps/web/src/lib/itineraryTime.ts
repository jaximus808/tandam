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
