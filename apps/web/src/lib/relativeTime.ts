/* Relative-time helpers for the fleet surfaces (roster + activity feed).
 *
 * Both surfaces put "how long" in the same right-hand mono column, so they have
 * to agree on the shape of that string to the character. Lifted out of
 * FleetView when the feed arrived (TDM-48) rather than duplicated. */

/** "12m" / "3h" / "2d" — the age of an ISO timestamp, or "—" when unknown. */
export function ageOf(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The full local timestamp, for the `title` behind an age. */
export function fullDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}
