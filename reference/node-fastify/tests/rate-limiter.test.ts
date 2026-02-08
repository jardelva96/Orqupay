import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/infra/rate-limiter.js";

describe("InMemoryRateLimiter", () => {
  it("allows requests inside the configured window", () => {
    const nowMs = 1_000;
    const limiter = new InMemoryRateLimiter({
      windowSeconds: 1,
      maxRequests: 2,
      nowMs: () => nowMs,
    });

    const first = limiter.consume("merchant_a");
    const second = limiter.consume("merchant_a");

    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(2);
    expect(first.remaining).toBe(1);
    expect(first.retryAfterSeconds).toBe(0);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
  });

  it("blocks requests that exceed quota and allows again after refill interval", () => {
    let nowMs = 5_000;
    const limiter = new InMemoryRateLimiter({
      windowSeconds: 10,
      maxRequests: 1,
      nowMs: () => nowMs,
    });

    const first = limiter.consume("merchant_a");
    const second = limiter.consume("merchant_a");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);

    nowMs = 15_000;
    const third = limiter.consume("merchant_a");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("keeps independent counters per identity", () => {
    const limiter = new InMemoryRateLimiter({
      windowSeconds: 60,
      maxRequests: 1,
      nowMs: () => 1_000,
    });

    const merchantA = limiter.consume("merchant_a");
    const merchantB = limiter.consume("merchant_b");
    const merchantASecond = limiter.consume("merchant_a");

    expect(merchantA.allowed).toBe(true);
    expect(merchantB.allowed).toBe(true);
    expect(merchantASecond.allowed).toBe(false);
  });
});
