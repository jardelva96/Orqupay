import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../src/adapters/inmemory/idempotency-store.js";
import type { ClockPort } from "../src/infra/clock.js";

class MutableClock implements ClockPort {
  constructor(private now: string) {}

  nowIso(): string {
    return this.now;
  }

  setNow(nextNow: string): void {
    this.now = nextNow;
  }
}

describe("InMemoryIdempotencyStore", () => {
  it("keeps idempotency records within ttl window", async () => {
    const clock = new MutableClock("2026-02-08T10:00:00.000Z");
    const store = new InMemoryIdempotencyStore({ ttlSeconds: 60, clock });
    await store.put("create_payment_intent", "idem-1", {
      fingerprint: "fp_1",
      statusCode: 201,
      body: { id: "pi_1" },
      createdAt: "2026-02-08T09:59:30.000Z",
    });

    const record = await store.get<{ id: string }>("create_payment_intent", "idem-1");
    expect(record).not.toBeNull();
    expect(record?.body.id).toBe("pi_1");
  });

  it("expires and evicts idempotency records outside ttl window", async () => {
    const clock = new MutableClock("2026-02-08T10:00:00.000Z");
    const store = new InMemoryIdempotencyStore({ ttlSeconds: 60, clock });
    await store.put("create_payment_intent", "idem-2", {
      fingerprint: "fp_2",
      statusCode: 201,
      body: { id: "pi_2" },
      createdAt: "2026-02-08T09:58:59.000Z",
    });

    const expired = await store.get<{ id: string }>("create_payment_intent", "idem-2");
    expect(expired).toBeNull();

    clock.setNow("2026-02-08T10:01:00.000Z");
    const evicted = await store.get<{ id: string }>("create_payment_intent", "idem-2");
    expect(evicted).toBeNull();
  });

  it("serializes concurrent operations for the same idempotency scope and key", async () => {
    const store = new InMemoryIdempotencyStore();
    const timeline: string[] = [];

    const first = store.withKeyLock("create_payment_intent", "idem-lock", async () => {
      timeline.push("first:start");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      timeline.push("first:end");
      return "first";
    });

    const second = store.withKeyLock("create_payment_intent", "idem-lock", async () => {
      timeline.push("second:start");
      timeline.push("second:end");
      return "second";
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(timeline).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
