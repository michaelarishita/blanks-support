import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit", () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.check("a", 0)).toBe(true);
    expect(limiter.check("a", 1)).toBe(true);
    expect(limiter.check("a", 2)).toBe(true);
  });

  it("blocks past the limit", () => {
    const limiter = createRateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.check("a", i);
    expect(limiter.check("a", 4)).toBe(false);
    expect(limiter.check("a", 5)).toBe(false);
  });

  it("keeps addresses independent", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.check("a", 0)).toBe(true);
    expect(limiter.check("a", 1)).toBe(false);
    // One noisy address must not lock out everyone behind a different one.
    expect(limiter.check("b", 1)).toBe(true);
  });

  it("opens a fresh window once the old one passes", () => {
    const limiter = createRateLimiter(2, 1_000);
    expect(limiter.check("a", 0)).toBe(true);
    expect(limiter.check("a", 10)).toBe(true);
    expect(limiter.check("a", 20)).toBe(false);
    expect(limiter.check("a", 1_500)).toBe(true);
  });

  it("counts the blocked calls as part of the window", () => {
    // Hammering while blocked must not reset anything — otherwise the limit
    // is trivially defeated by hammering harder.
    const limiter = createRateLimiter(1, 1_000);
    limiter.check("a", 0);
    for (let t = 1; t < 900; t += 100) expect(limiter.check("a", t)).toBe(false);
    expect(limiter.check("a", 950)).toBe(false);
  });

  /**
   * The leak in the limiter this replaced: it never removed anything, so the
   * Map grew by one entry per unique address for the life of the instance.
   * Quiet, unbounded, and only visible weeks later as a memory ceiling.
   */
  it("forgets keys once their window has passed", () => {
    const limiter = createRateLimiter(5, 1_000);
    for (let i = 0; i < 100; i++) limiter.check(`addr-${i}`, 0);
    expect(limiter.size()).toBe(100);

    // One call in a later window prunes everything the old one held.
    limiter.check("someone-else", 5_000);
    expect(limiter.size()).toBe(1);
  });

  it("does not forget a key that is still inside its window", () => {
    const limiter = createRateLimiter(5, 10_000);
    limiter.check("a", 0);
    limiter.check("b", 9_000);
    expect(limiter.size()).toBe(2);
  });
});
