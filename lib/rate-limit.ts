/**
 * A fixed-window counter, per key.
 *
 * SCOPE, honestly stated: this lives in one serverless instance's memory, so
 * N instances mean N windows and a restart forgets everything. It stops a
 * naive burst from one address, which is what it is for. It is not a defence
 * against a distributed flood, and the honeypot and content validation remain
 * the real controls on the intake endpoint.
 *
 * Pure and clock-injectable so the boundaries can be tested without waiting.
 */

export interface RateLimiter {
  /** True when the call is allowed; false when the key is over its limit. */
  check(key: string, now?: number): boolean;
  /** Exposed for tests — the number of keys currently held. */
  size(): number;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>();

  /**
   * Expired keys are dropped on every call.
   *
   * The previous inline limiter never removed anything, so its Map grew by one
   * entry per unique address for the life of the instance — slow, quiet, and
   * exactly the shape of leak that only shows up as a memory ceiling weeks
   * later.
   */
  function prune(now: number): void {
    for (const [key, record] of hits) {
      if (now - record.windowStart > windowMs) hits.delete(key);
    }
  }

  return {
    check(key: string, now = Date.now()): boolean {
      prune(now);

      const record = hits.get(key);
      if (!record || now - record.windowStart > windowMs) {
        hits.set(key, { count: 1, windowStart: now });
        return true;
      }

      record.count += 1;
      return record.count <= limit;
    },
    size: () => hits.size,
  };
}
