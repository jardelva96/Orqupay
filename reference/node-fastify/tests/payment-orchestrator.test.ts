import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../src/adapters/inmemory/event-bus.js";
import { InMemoryIdempotencyStore } from "../src/adapters/inmemory/idempotency-store.js";
import { InMemoryPaymentRepository } from "../src/adapters/inmemory/payment-repository.js";
import { InMemoryRiskEngine } from "../src/adapters/inmemory/risk-engine.js";
import { MockProviderGateway } from "../src/adapters/providers/mock-provider.js";
import { PaymentOrchestrator } from "../src/application/payment-orchestrator.js";
import { ProviderRouter } from "../src/application/provider-router.js";
import { SystemClock } from "../src/infra/clock.js";
import type { PaymentIntentRecord } from "../src/domain/types.js";

class SlowPaymentRepository extends InMemoryPaymentRepository {
  override async savePaymentIntent(intent: PaymentIntentRecord): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await super.savePaymentIntent(intent);
  }
}

describe("PaymentOrchestrator events", () => {
  it("publishes events with api_version", async () => {
    const repository = new InMemoryPaymentRepository();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const eventBus = new InMemoryEventBus();
    const riskEngine = new InMemoryRiskEngine({ reviewAmountThreshold: 1_000_000 });
    const clock = new SystemClock();
    const providerRouter = new ProviderRouter(
      [
        new MockProviderGateway({
          name: "provider_a",
          supportedMethods: ["card", "pix", "boleto"],
        }),
      ],
      {
        defaultProvider: "provider_a",
        methodPriority: { card: ["provider_a"] },
      },
    );

    const orchestrator = new PaymentOrchestrator(
      repository,
      idempotencyStore,
      eventBus,
      providerRouter,
      riskEngine,
      clock,
      "2026-02-08.2",
      "payment-module-core-test",
      "1.0.1",
    );

    const created = await orchestrator.createPaymentIntent(
      {
        amount: 2100,
        currency: "BRL",
        customer: { id: "cus_orchestrator_event" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
      "orchestrator-event-create",
    );
    await orchestrator.confirmPaymentIntent(created.body.id, "orchestrator-event-confirm");

    const events = eventBus.getPublishedEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((event) => event.api_version === "2026-02-08.2")).toBe(true);
    expect(events.every((event) => event.source === "payment-module-core-test")).toBe(true);
    expect(events.every((event) => event.event_version === "1.0.1")).toBe(true);
    expect(events.some((event) => event.type === "payment_intent.created")).toBe(true);
    expect(events.some((event) => event.type === "payment_intent.succeeded")).toBe(true);
  });

  it("serializes concurrent create requests for the same idempotency key", async () => {
    const repository = new SlowPaymentRepository();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const eventBus = new InMemoryEventBus();
    const riskEngine = new InMemoryRiskEngine({ reviewAmountThreshold: 1_000_000 });
    const clock = new SystemClock();
    const providerRouter = new ProviderRouter(
      [
        new MockProviderGateway({
          name: "provider_a",
          supportedMethods: ["card", "pix", "boleto"],
        }),
      ],
      {
        defaultProvider: "provider_a",
        methodPriority: { card: ["provider_a"] },
      },
    );

    const orchestrator = new PaymentOrchestrator(
      repository,
      idempotencyStore,
      eventBus,
      providerRouter,
      riskEngine,
      clock,
      "2026-02-08.2",
      "payment-module-core-test",
      "1.0.1",
    );

    const payload = {
      amount: 2100,
      currency: "BRL" as const,
      customer: { id: "cus_orchestrator_parallel" },
      payment_method: { type: "card" as const, token: "tok_test_visa" },
      capture_method: "automatic" as const,
    };

    const [first, second] = await Promise.all([
      orchestrator.createPaymentIntent(payload, "orchestrator-concurrent-create"),
      orchestrator.createPaymentIntent(payload, "orchestrator-concurrent-create"),
    ]);

    expect(first.body.id).toBe(second.body.id);
    expect([first.idempotencyReplayed, second.idempotencyReplayed].sort()).toEqual([false, true]);

    const events = eventBus.getPublishedEvents().filter((event) => event.type === "payment_intent.created");
    expect(events).toHaveLength(1);
  });
});
