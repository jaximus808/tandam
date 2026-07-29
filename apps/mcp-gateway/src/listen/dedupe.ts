/**
 * Delivery-id dedupe. Tandem retries a failed delivery on a 1m / 10m / 1h
 * schedule with a FRESH signature but the SAME `Tandem-Delivery-Id`, so a
 * receiver that acked slowly (or crashed after acking) must not run the
 * orchestrator twice for one approval.
 *
 * Bounded on purpose: a long-lived listener would otherwise grow a set of every
 * delivery id it has ever seen. Insertion-ordered eviction (Set iteration order
 * is insertion order) keeps the most recent `capacity` ids, which comfortably
 * outlives the retry schedule for any realistic event rate.
 */
export class DeliveryDedupe {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = 1000) {
    if (capacity < 1) throw new Error("dedupe capacity must be >= 1");
  }

  /**
   * Record `id` and report whether it had already been seen.
   *
   * Returns true → this is a duplicate; ack 200 and do nothing else.
   * An empty/absent id can't be deduped, so it is always treated as new (the
   * caller logs that case; better to run twice than to swallow an approval).
   */
  seen(id: string | undefined): boolean {
    if (!id) return false;
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      // Oldest insertion wins the eviction.
      const oldest = this.ids.values().next();
      if (!oldest.done) this.ids.delete(oldest.value);
    }
    return false;
  }

  get size(): number {
    return this.ids.size;
  }
}
