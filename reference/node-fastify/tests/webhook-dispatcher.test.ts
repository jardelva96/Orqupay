import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookDispatcher } from "../src/application/webhook-dispatcher.js";
import type {
  PaymentEvent,
  StoredWebhookDeadLetterRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from "../src/domain/types.js";
import type { ClockPort } from "../src/infra/clock.js";
import type { WebhookRepositoryPort } from "../src/ports/webhook-repository.js";
import type { WebhookSendInput, WebhookSenderPort } from "../src/ports/webhook-sender.js";

function expectedKeyId(secret: string): string {
  return `whk_${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

function sampleEvent(): PaymentEvent {
  return {
    id: "evt_test_123",
    api_version: "2026-02-08",
    source: "payment-module-core",
    event_version: "1.0.0",
    type: "payment_intent.created",
    occurred_at: "2026-02-08T00:00:00.000Z",
    data: { id: "pi_test_123" },
  };
}

class FixedClock implements ClockPort {
  nowIso(): string {
    return "2026-02-08T01:00:00.000Z";
  }
}

function buildRepository(
  endpoint: WebhookEndpointRecord,
  deliveries: WebhookDeliveryRecord[],
  deadLetters: StoredWebhookDeadLetterRecord[],
): WebhookRepositoryPort {
  return {
    async createEndpoint() {
      throw new Error("not used");
    },
    async getEndpointById() {
      throw new Error("not used");
    },
    async updateEndpoint() {
      throw new Error("not used");
    },
    async rotateEndpointSecret() {
      throw new Error("not used");
    },
    async listEndpoints() {
      throw new Error("not used");
    },
    async listEnabledEndpointsByEvent() {
      return [endpoint];
    },
    async saveDelivery(delivery) {
      deliveries.push(delivery);
    },
    async listDeliveries() {
      throw new Error("not used");
    },
    async saveDeadLetter(deadLetter) {
      deadLetters.push(deadLetter);
    },
    async listDeadLetters() {
      throw new Error("not used");
    },
    async getDeadLetterById() {
      throw new Error("not used");
    },
    async updateDeadLetter() {
      throw new Error("not used");
    },
  };
}

describe("WebhookDispatcher", () => {
  it("sends signature key id derived from endpoint secret", async () => {
    const endpoint: WebhookEndpointRecord = {
      id: "we_test_1",
      url: "memory://merchant/orders",
      events: ["payment_intent.created"],
      secret: "whsec_secret_alpha",
      enabled: true,
      created_at: "2026-02-08T00:00:00.000Z",
    };
    const deliveries: WebhookDeliveryRecord[] = [];
    const deadLetters: StoredWebhookDeadLetterRecord[] = [];
    const requests: WebhookSendInput[] = [];
    const repository = buildRepository(endpoint, deliveries, deadLetters);

    const sender: WebhookSenderPort = {
      async send(input) {
        requests.push(input);
        return { ok: true, statusCode: 200 };
      },
    };

    const dispatcher = new WebhookDispatcher(repository, sender, new FixedClock(), {
      maxAttempts: 3,
      timeoutMs: 5000,
    });

    await dispatcher.dispatch(sampleEvent());

    expect(requests.length).toBe(1);
    const request = requests.at(0);
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected at least one webhook send request.");
    }
    expect(request.headers["X-PMC-Signature-Key-Id"]).toBe(expectedKeyId(endpoint.secret));
    expect(typeof request.headers["X-PMC-Signature"]).toBe("string");
    expect(deliveries.length).toBe(1);
    expect(deadLetters.length).toBe(0);
    const delivery = deliveries.at(0);
    expect(delivery).toBeDefined();
    if (!delivery) {
      throw new Error("Expected at least one saved delivery.");
    }
    expect(delivery.status).toBe("succeeded");
  });

  it("stores dead letter when max attempts are exhausted", async () => {
    const endpoint: WebhookEndpointRecord = {
      id: "we_test_fail_1",
      url: "memory://merchant/always-fail",
      events: ["payment_intent.created"],
      secret: "whsec_secret_beta",
      enabled: true,
      created_at: "2026-02-08T00:00:00.000Z",
    };
    const deliveries: WebhookDeliveryRecord[] = [];
    const deadLetters: StoredWebhookDeadLetterRecord[] = [];
    let sends = 0;
    const repository = buildRepository(endpoint, deliveries, deadLetters);
    const sender: WebhookSenderPort = {
      async send() {
        sends += 1;
        return { ok: false, errorCode: "transient_webhook_error" };
      },
    };
    const dispatcher = new WebhookDispatcher(repository, sender, new FixedClock(), {
      maxAttempts: 3,
      timeoutMs: 5000,
    });

    await dispatcher.dispatch(sampleEvent());

    expect(sends).toBe(3);
    expect(deliveries.length).toBe(3);
    expect(deadLetters.length).toBe(1);
    const deadLetter = deadLetters.at(0);
    expect(deadLetter).toBeDefined();
    if (!deadLetter) {
      throw new Error("Expected one dead letter for exhausted attempts.");
    }
    expect(deadLetter.failure_reason).toBe("max_attempts_exhausted");
    expect(deadLetter.attempts).toBe(3);
    expect(deadLetter.status).toBe("pending");
    expect(deadLetter.replay_count).toBe(0);
    expect(deadLetter.error_code).toBe("transient_webhook_error");
  });

  it("stores dead letter after permanent failure without retry loop", async () => {
    const endpoint: WebhookEndpointRecord = {
      id: "we_test_fail_2",
      url: "memory://merchant/permanent-fail",
      events: ["payment_intent.created"],
      secret: "whsec_secret_gamma",
      enabled: true,
      created_at: "2026-02-08T00:00:00.000Z",
    };
    const deliveries: WebhookDeliveryRecord[] = [];
    const deadLetters: StoredWebhookDeadLetterRecord[] = [];
    let sends = 0;
    const repository = buildRepository(endpoint, deliveries, deadLetters);
    const sender: WebhookSenderPort = {
      async send() {
        sends += 1;
        return { ok: false, statusCode: 400, errorCode: "invalid_webhook_request" };
      },
    };
    const dispatcher = new WebhookDispatcher(repository, sender, new FixedClock(), {
      maxAttempts: 3,
      timeoutMs: 5000,
    });

    await dispatcher.dispatch(sampleEvent());

    expect(sends).toBe(1);
    expect(deliveries.length).toBe(1);
    expect(deadLetters.length).toBe(1);
    const deadLetter = deadLetters.at(0);
    expect(deadLetter).toBeDefined();
    if (!deadLetter) {
      throw new Error("Expected one dead letter for permanent failure.");
    }
    expect(deadLetter.failure_reason).toBe("permanent_failure");
    expect(deadLetter.attempts).toBe(1);
    expect(deadLetter.status).toBe("pending");
    expect(deadLetter.replay_count).toBe(0);
    expect(deadLetter.response_status).toBe(400);
  });
});
