import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { CursorTokenService } from "../src/infra/cursor-token.js";

function withAuth(headers?: Record<string, string>): Record<string, string> {
  return {
    authorization: "Bearer dev_pmc_key",
    ...(headers ?? {}),
  };
}

function withAuthAndIdempotency(key: string): Record<string, string> {
  return withAuth({ "Idempotency-Key": key });
}

describe("Payment API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects requests without API key", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: { "Idempotency-Key": "no-auth-1" },
      payload: {
        amount: 10990,
        currency: "BRL",
        customer: { id: "cus_123" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    expect(create.statusCode).toBe(401);
    expect(create.json().error.code).toBe("missing_api_key");
  });

  it("accepts multiple API keys during key rotation window", async () => {
    const appWithRotatingKeys = buildApp({
      host: "0.0.0.0",
      port: 8080,
      apiKey: "new_rotated_key_12345678",
      apiKeys: ["new_rotated_key_12345678", "old_rotated_key_12345678"],
      cursorSecret: "dev_cursor_secret_change_me_2026",
      cursorVerificationSecrets: ["dev_cursor_secret_change_me_2026"],
      idempotencyKeyMaxLength: 128,
      idempotencyTtlSeconds: 86400,
      listDefaultLimit: 50,
      listMaxLimit: 500,
      eventApiVersion: "2026-02-08",
      eventSource: "payment-module-core",
      eventSchemaVersion: "1.0.0",
      riskReviewAmountThreshold: 1_000_000,
      webhookMaxAttempts: 3,
      webhookTimeoutMs: 5000,
      providerCircuitBreakerEnabled: true,
      providerCircuitBreakerFailureThreshold: 3,
      providerCircuitBreakerCooldownSeconds: 30,
      providerCircuitBreakerTransientOnly: true,
      metricsEnabled: false,
      rateLimitEnabled: true,
      rateLimitWindowSeconds: 1,
      rateLimitMaxRequests: 1000,
    });
    await appWithRotatingKeys.ready();

    try {
      const withNewKey = await appWithRotatingKeys.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: {
          authorization: "Bearer new_rotated_key_12345678",
        },
      });
      const withOldKey = await appWithRotatingKeys.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: {
          authorization: "Bearer old_rotated_key_12345678",
        },
      });
      const invalidKey = await appWithRotatingKeys.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: {
          authorization: "Bearer invalid_rotated_key_12345678",
        },
      });

      expect(withNewKey.statusCode).toBe(200);
      expect(withOldKey.statusCode).toBe(200);
      expect(invalidKey.statusCode).toBe(401);
      expect(invalidKey.json().error.code).toBe("invalid_api_key");
    } finally {
      await appWithRotatingKeys.close();
    }
  });

  it("exposes health endpoints without authentication", async () => {
    const live = await app.inject({
      method: "GET",
      url: "/health/live",
    });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe("ok");

    const ready = await app.inject({
      method: "GET",
      url: "/health/ready",
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");
  });

  it("exposes prometheus metrics and tracks idempotency replays", async () => {
    const payload = {
      amount: 10990,
      currency: "BRL",
      customer: { id: "cus_metrics" },
      payment_method: { type: "card", token: "tok_test_visa" },
      capture_method: "automatic",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("metrics-idem-1"),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("metrics-idem-1"),
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const paymentIntentId = first.json().id as string;

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("metrics-confirm-1"),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("succeeded");

    const refund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("metrics-refund-1"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 1000,
      },
    });
    expect(refund.statusCode).toBe(201);
    expect(refund.json().status).toBe("succeeded");

    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
    });

    expect(metrics.statusCode).toBe(200);
    expect(String(metrics.headers["content-type"])).toContain("text/plain");
    expect(metrics.body).toContain("pmc_http_requests_total");
    expect(metrics.body).toContain('pmc_idempotency_replays_total{operation="create_payment_intent"} 1');
    expect(metrics.body).toContain(
      'pmc_http_request_duration_seconds_count{method="POST",route="/v1/payment-intents"} 2',
    );
    expect(metrics.body).toContain('pmc_payment_events_total{event_type="payment_intent.created"} 1');
    expect(metrics.body).toContain('pmc_payment_events_total{event_type="payment_intent.processing"} 1');
    expect(metrics.body).toContain('pmc_payment_events_total{event_type="payment_intent.succeeded"} 1');
    expect(metrics.body).toContain('pmc_payment_events_total{event_type="refund.succeeded"} 1');
    expect(metrics.body).toContain('pmc_payment_intent_status_total{status="requires_confirmation"} 1');
    expect(metrics.body).toContain('pmc_payment_intent_status_total{status="processing"} 1');
    expect(metrics.body).toContain('pmc_payment_intent_status_total{status="succeeded"} 1');
    expect(metrics.body).toContain('pmc_refund_status_total{status="succeeded"} 1');
  });

  it("does not expose metrics endpoint when disabled", async () => {
    const appWithoutMetrics = buildApp({
      host: "0.0.0.0",
      port: 8080,
      apiKey: "dev_pmc_key",
      apiKeys: ["dev_pmc_key"],
      cursorSecret: "dev_cursor_secret_change_me_2026",
      cursorVerificationSecrets: ["dev_cursor_secret_change_me_2026"],
      idempotencyKeyMaxLength: 128,
      idempotencyTtlSeconds: 86400,
      listDefaultLimit: 50,
      listMaxLimit: 500,
      eventApiVersion: "2026-02-08",
      eventSource: "payment-module-core",
      eventSchemaVersion: "1.0.0",
      riskReviewAmountThreshold: 1_000_000,
      webhookMaxAttempts: 3,
      webhookTimeoutMs: 5000,
      providerCircuitBreakerEnabled: true,
      providerCircuitBreakerFailureThreshold: 3,
      providerCircuitBreakerCooldownSeconds: 30,
      providerCircuitBreakerTransientOnly: true,
      metricsEnabled: false,
      rateLimitEnabled: true,
      rateLimitWindowSeconds: 1,
      rateLimitMaxRequests: 1000,
    });
    await appWithoutMetrics.ready();

    try {
      const metrics = await appWithoutMetrics.inject({
        method: "GET",
        url: "/metrics",
        headers: withAuth(),
      });
      expect(metrics.statusCode).toBe(404);
      expect(metrics.json().error.code).toBe("resource_not_found");
    } finally {
      await appWithoutMetrics.close();
    }
  });

  it("enforces rate limit and exposes rate-limit headers", async () => {
    const appWithStrictRateLimit = buildApp({
      host: "0.0.0.0",
      port: 8080,
      apiKey: "dev_pmc_key",
      apiKeys: ["dev_pmc_key"],
      cursorSecret: "dev_cursor_secret_change_me_2026",
      cursorVerificationSecrets: ["dev_cursor_secret_change_me_2026"],
      idempotencyKeyMaxLength: 128,
      idempotencyTtlSeconds: 86400,
      listDefaultLimit: 50,
      listMaxLimit: 500,
      eventApiVersion: "2026-02-08",
      eventSource: "payment-module-core",
      eventSchemaVersion: "1.0.0",
      riskReviewAmountThreshold: 1_000_000,
      webhookMaxAttempts: 3,
      webhookTimeoutMs: 5000,
      providerCircuitBreakerEnabled: true,
      providerCircuitBreakerFailureThreshold: 3,
      providerCircuitBreakerCooldownSeconds: 30,
      providerCircuitBreakerTransientOnly: true,
      metricsEnabled: true,
      rateLimitEnabled: true,
      rateLimitWindowSeconds: 60,
      rateLimitMaxRequests: 2,
    });
    await appWithStrictRateLimit.ready();

    try {
      const first = await appWithStrictRateLimit.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: withAuth(),
      });
      const second = await appWithStrictRateLimit.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: withAuth(),
      });
      const third = await appWithStrictRateLimit.inject({
        method: "GET",
        url: "/v1/webhook-endpoints",
        headers: withAuth(),
      });

      expect(first.statusCode).toBe(200);
      expect(first.headers["ratelimit-limit"]).toBe("2");
      expect(first.headers["ratelimit-remaining"]).toBe("1");

      expect(second.statusCode).toBe(200);
      expect(second.headers["ratelimit-limit"]).toBe("2");
      expect(second.headers["ratelimit-remaining"]).toBe("0");

      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe("rate_limit_exceeded");
      expect(third.headers["ratelimit-limit"]).toBe("2");
      expect(third.headers["ratelimit-remaining"]).toBe("0");
      expect(third.headers["retry-after"]).toBeTypeOf("string");

      const metrics = await appWithStrictRateLimit.inject({
        method: "GET",
        url: "/metrics",
      });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain('pmc_http_rate_limited_total{scope="api_key"} 1');
    } finally {
      await appWithStrictRateLimit.close();
    }
  });

  it("rejects mutating endpoints without Idempotency-Key", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("missing-idem-create"),
      payload: {
        amount: 10990,
        currency: "BRL",
        customer: { id: "cus_missing_idem" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/confirm`,
      headers: withAuth(),
    });

    expect(confirm.statusCode).toBe(400);
    expect(confirm.json().error.code).toBe("missing_idempotency_key");

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/cancel`,
      headers: withAuth(),
    });
    expect(cancel.statusCode).toBe(400);
    expect(cancel.json().error.code).toBe("missing_idempotency_key");
  });

  it("rejects invalid Idempotency-Key format", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuth({ "Idempotency-Key": "bad key with spaces" }),
      payload: {
        amount: 10990,
        currency: "BRL",
        customer: { id: "cus_bad_idem" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    expect(create.statusCode).toBe(422);
    expect(create.json().error.code).toBe("invalid_idempotency_key");
  });

  it("rejects too long Idempotency-Key", async () => {
    const longKey = "x".repeat(129);
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuth({ "Idempotency-Key": longKey }),
      payload: {
        amount: 10990,
        currency: "BRL",
        customer: { id: "cus_long_idem" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    expect(create.statusCode).toBe(422);
    expect(create.json().error.code).toBe("invalid_idempotency_key");
  });

  it("creates and confirms an automatic payment intent", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("create-auto-1"),
      payload: {
        amount: 10990,
        currency: "BRL",
        customer: { id: "cus_123" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    expect(create.statusCode).toBe(201);
    expect(create.headers["x-idempotency-replayed"]).toBe("false");
    expect(create.headers["idempotency-key"]).toBe("create-auto-1");
    const created = create.json();
    expect(created.status).toBe("requires_confirmation");
    expect(created.customer_id).toBe("cus_123");
    expect(created.payment_method_type).toBe("card");
    expect(created.authorized_amount).toBe(0);
    expect(created.captured_amount).toBe(0);
    expect(created.refunded_amount).toBe(0);
    expect(created.amount_refundable).toBe(0);
    expect(created.provider).toBeNull();
    expect(created.provider_reference).toBeNull();

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${created.id}/confirm`,
      headers: withAuthAndIdempotency("confirm-auto-1"),
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers["x-idempotency-replayed"]).toBe("false");
    expect(confirm.headers["idempotency-key"]).toBe("confirm-auto-1");
    expect(confirm.json().status).toBe("succeeded");
    expect(confirm.json().customer_id).toBe("cus_123");
    expect(confirm.json().payment_method_type).toBe("card");
    expect(confirm.json().authorized_amount).toBe(10990);
    expect(confirm.json().captured_amount).toBe(10990);
    expect(confirm.json().refunded_amount).toBe(0);
    expect(confirm.json().amount_refundable).toBe(10990);
    expect(confirm.json().provider).toBe("provider_b");
    expect(confirm.json().provider_reference).toBeTypeOf("string");
  });

  it("lists payment intents with cursor pagination", async () => {
    for (const key of ["list-intents-1", "list-intents-2", "list-intents-3"]) {
      const created = await app.inject({
        method: "POST",
        url: "/v1/payment-intents",
        headers: withAuthAndIdempotency(key),
        payload: {
          amount: 1390,
          currency: "BRL",
          customer: { id: `cus_${key}` },
          payment_method: { type: "pix", token: "tok_test_pix" },
          capture_method: "automatic",
        },
      });
      expect(created.statusCode).toBe(201);
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?limit=2",
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();
    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(2);
    expect(firstPageBody.pagination.limit).toBe(2);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const firstPageIds = new Set<string>(firstPageBody.data.map((item) => item.id));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/payment-intents?limit=2&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();
    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    const secondPageFirstItem = secondPageBody.data.at(0);
    expect(secondPageFirstItem).toBeDefined();
    if (!secondPageFirstItem) {
      throw new Error("Expected at least one payment intent in second page.");
    }
    expect(firstPageIds.has(secondPageFirstItem.id)).toBe(false);
  });

  it("filters payment intents by currency, status, customer_id, provider, provider_reference and payment_method_type", async () => {
    const succeededCreate = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("list-filter-succeeded-create"),
      payload: {
        amount: 1490,
        currency: "BRL",
        customer: { id: "cus_filter_success" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const succeededId = succeededCreate.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${succeededId}/confirm`,
      headers: withAuthAndIdempotency("list-filter-succeeded-confirm"),
    });
    const succeededConfirm = await app.inject({
      method: "GET",
      url: `/v1/payment-intents/${succeededId}`,
      headers: withAuth(),
    });
    expect(succeededConfirm.statusCode).toBe(200);
    const succeededProviderReference = succeededConfirm.json().provider_reference as string;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("list-filter-pending-create"),
      payload: {
        amount: 1590,
        currency: "USD",
        customer: { id: "cus_filter_pending" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const byCurrency = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?currency=brl",
      headers: withAuth(),
    });
    expect(byCurrency.statusCode).toBe(200);
    expect(byCurrency.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byCurrency
        .json()
        .data.every((item: { id: string; currency: string }) => item.id === succeededId && item.currency === "BRL"),
    ).toBe(true);

    const byStatus = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?status=succeeded",
      headers: withAuth(),
    });
    expect(byStatus.statusCode).toBe(200);
    expect(byStatus.json().data.every((item: { status: string }) => item.status === "succeeded")).toBe(true);

    const byCustomer = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?customer_id=cus_filter_success",
      headers: withAuth(),
    });
    expect(byCustomer.statusCode).toBe(200);
    expect(byCustomer.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byCustomer.json().data.every((item: { id: string }) => item.id === succeededId),
    ).toBe(true);

    const byPaymentMethodType = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?payment_method_type=card",
      headers: withAuth(),
    });
    expect(byPaymentMethodType.statusCode).toBe(200);
    expect(byPaymentMethodType.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byPaymentMethodType
        .json()
        .data.every(
          (item: { id: string; payment_method_type: string; provider: string | null }) =>
            item.id === succeededId && item.payment_method_type === "card" && item.provider === "provider_b",
        ),
    ).toBe(true);

    const byProvider = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?provider=provider_b",
      headers: withAuth(),
    });
    expect(byProvider.statusCode).toBe(200);
    expect(byProvider.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byProvider
        .json()
        .data.every(
          (item: { id: string; provider: string | null }) =>
            item.id === succeededId && item.provider === "provider_b",
        ),
    ).toBe(true);

    const byProviderReference = await app.inject({
      method: "GET",
      url: `/v1/payment-intents?provider_reference=${succeededProviderReference}`,
      headers: withAuth(),
    });
    expect(byProviderReference.statusCode).toBe(200);
    expect(byProviderReference.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byProviderReference.json().data.every(
        (item: { id: string; provider_reference: string | null }) =>
          item.id === succeededId && item.provider_reference === succeededProviderReference,
      ),
    ).toBe(true);

    const byAmountRange = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?amount_min=1400&amount_max=1500",
      headers: withAuth(),
    });
    expect(byAmountRange.statusCode).toBe(200);
    expect(byAmountRange.json().data.length).toBeGreaterThanOrEqual(1);
    expect(
      byAmountRange.json().data.every((item: { id: string; amount: number }) => item.id === succeededId && item.amount === 1490),
    ).toBe(true);
  });

  it("filters payment intents by created range", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("list-filter-created-range-create"),
      payload: {
        amount: 1690,
        currency: "BRL",
        customer: { id: "cus_filter_created_range" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const futureWindow = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?created_from=2099-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(futureWindow.statusCode).toBe(200);
    expect(futureWindow.json().data.length).toBe(0);

    const oldWindow = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?created_to=2000-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(oldWindow.statusCode).toBe(200);
    expect(oldWindow.json().data.length).toBe(0);
  });

  it("rejects invalid payment-intent list filters", async () => {
    const invalidStatus = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?status=unknown",
      headers: withAuth(),
    });
    expect(invalidStatus.statusCode).toBe(422);
    expect(invalidStatus.json().error.code).toBe("invalid_payment_status");

    const invalidCreatedFrom = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?created_from=not-a-date",
      headers: withAuth(),
    });
    expect(invalidCreatedFrom.statusCode).toBe(422);
    expect(invalidCreatedFrom.json().error.code).toBe("invalid_created_from");

    const invalidPaymentMethodType = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?payment_method_type=crypto",
      headers: withAuth(),
    });
    expect(invalidPaymentMethodType.statusCode).toBe(422);
    expect(invalidPaymentMethodType.json().error.code).toBe("invalid_payment_method_type");

    const invalidCurrency = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?currency=BR",
      headers: withAuth(),
    });
    expect(invalidCurrency.statusCode).toBe(422);
    expect(invalidCurrency.json().error.code).toBe("invalid_currency");

    const invalidAmountMin = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?amount_min=abc",
      headers: withAuth(),
    });
    expect(invalidAmountMin.statusCode).toBe(422);
    expect(invalidAmountMin.json().error.code).toBe("invalid_amount_min");

    const invalidAmountRange = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?amount_min=2000&amount_max=1000",
      headers: withAuth(),
    });
    expect(invalidAmountRange.statusCode).toBe(422);
    expect(invalidAmountRange.json().error.code).toBe("invalid_amount_range");

    const invalidProvider = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?provider=",
      headers: withAuth(),
    });
    expect(invalidProvider.statusCode).toBe(422);
    expect(invalidProvider.json().error.code).toBe("invalid_provider");

    const invalidProviderReference = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?provider_reference=",
      headers: withAuth(),
    });
    expect(invalidProviderReference.statusCode).toBe(422);
    expect(invalidProviderReference.json().error.code).toBe("invalid_provider_reference");

    const invalidRange = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?created_from=2026-12-31T00:00:00.000Z&created_to=2026-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidRange.statusCode).toBe(422);
    expect(invalidRange.json().error.code).toBe("invalid_created_range");
  });

  it("replays idempotent create request with same payload", async () => {
    const payload = {
      amount: 1000,
      currency: "BRL",
      customer: { id: "cus_100" },
      payment_method: { type: "pix", token: "tok_test_pix" },
      capture_method: "automatic",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("idem-1"),
      payload,
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("idem-1"),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.headers["x-idempotency-replayed"]).toBe("false");
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(first.headers["idempotency-key"]).toBe("idem-1");
    expect(second.headers["idempotency-key"]).toBe("idem-1");
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects idempotency key reuse with different payload", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("idem-conflict-1"),
      payload: {
        amount: 1000,
        currency: "BRL",
        customer: { id: "cus_100" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const second = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("idem-conflict-1"),
      payload: {
        amount: 9999,
        currency: "BRL",
        customer: { id: "cus_100" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("idempotency_conflict");
  });

  it("supports manual capture and full settlement", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("manual-capture-1"),
      payload: {
        amount: 5000,
        currency: "BRL",
        customer: { id: "cus_manual" },
        payment_method: { type: "card", token: "tok_test_manual" },
        capture_method: "manual",
      },
    });

    const id = create.json().id;
    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${id}/confirm`,
      headers: withAuthAndIdempotency("manual-capture-confirm-1"),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("requires_action");

    const capture = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${id}/capture`,
      headers: withAuthAndIdempotency("manual-capture-do-1"),
      payload: { amount: 5000 },
    });
    expect(capture.statusCode).toBe(200);
    expect(capture.json().status).toBe("succeeded");
  });

  it("creates refund after successful payment", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("refund-flow-create"),
      payload: {
        amount: 4500,
        currency: "BRL",
        customer: { id: "cus_refund" },
        payment_method: { type: "card", token: "tok_test_refund" },
        capture_method: "automatic",
      },
    });

    const id = create.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${id}/confirm`,
      headers: withAuthAndIdempotency("refund-flow-confirm"),
    });

    const refund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("refund-flow-refund"),
      payload: {
        payment_intent_id: id,
        amount: 1000,
      },
    });

    expect(refund.statusCode).toBe(201);
    expect(refund.headers["x-idempotency-replayed"]).toBe("false");
    expect(refund.headers["idempotency-key"]).toBe("refund-flow-refund");
    expect(refund.json().status).toBe("succeeded");

    const paymentIntent = await app.inject({
      method: "GET",
      url: `/v1/payment-intents/${id}`,
      headers: withAuth(),
    });
    expect(paymentIntent.statusCode).toBe(200);
    expect(paymentIntent.json().captured_amount).toBe(4500);
    expect(paymentIntent.json().refunded_amount).toBe(1000);
    expect(paymentIntent.json().amount_refundable).toBe(3500);
  });

  it("lists refunds with cursor pagination", async () => {
    for (const index of [1, 2, 3]) {
      const create = await app.inject({
        method: "POST",
        url: "/v1/payment-intents",
        headers: withAuthAndIdempotency(`refund-list-create-${index}`),
        payload: {
          amount: 2990,
          currency: "BRL",
          customer: { id: `cus_refund_list_${index}` },
          payment_method: { type: "card", token: "tok_test_visa" },
          capture_method: "automatic",
        },
      });
      const paymentIntentId = create.json().id;

      await app.inject({
        method: "POST",
        url: `/v1/payment-intents/${paymentIntentId}/confirm`,
        headers: withAuthAndIdempotency(`refund-list-confirm-${index}`),
      });

      const refund = await app.inject({
        method: "POST",
        url: "/v1/refunds",
        headers: withAuthAndIdempotency(`refund-list-refund-${index}`),
        payload: {
          payment_intent_id: paymentIntentId,
          amount: 1000,
        },
      });
      expect(refund.statusCode).toBe(201);
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/refunds?limit=2",
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();
    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(2);
    expect(firstPageBody.pagination.limit).toBe(2);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const firstPageIds = new Set<string>(firstPageBody.data.map((item) => item.id));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/refunds?limit=2&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();
    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    const secondPageFirstItem = secondPageBody.data.at(0);
    expect(secondPageFirstItem).toBeDefined();
    if (!secondPageFirstItem) {
      throw new Error("Expected at least one refund in second page.");
    }
    expect(firstPageIds.has(secondPageFirstItem.id)).toBe(false);
  });

  it("filters refunds by status and payment_intent_id", async () => {
    const succeededCreate = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("refund-filter-succeeded-create"),
      payload: {
        amount: 2890,
        currency: "BRL",
        customer: { id: "cus_refund_filter_succeeded" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const succeededPaymentIntentId = succeededCreate.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${succeededPaymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("refund-filter-succeeded-confirm"),
    });
    const succeededRefund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("refund-filter-succeeded-refund"),
      payload: {
        payment_intent_id: succeededPaymentIntentId,
        amount: 1200,
      },
    });
    expect(succeededRefund.statusCode).toBe(201);

    const failedCreate = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("refund-filter-failed-create"),
      payload: {
        amount: 2890,
        currency: "BRL",
        customer: { id: "cus_refund_filter_failed" },
        payment_method: { type: "card", token: "tok_test_refund_fail" },
        capture_method: "automatic",
      },
    });
    const failedPaymentIntentId = failedCreate.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${failedPaymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("refund-filter-failed-confirm"),
    });
    const failedRefund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("refund-filter-failed-refund"),
      payload: {
        payment_intent_id: failedPaymentIntentId,
        amount: 700,
      },
    });
    expect(failedRefund.statusCode).toBe(201);
    expect(failedRefund.json().status).toBe("failed");

    const byStatus = await app.inject({
      method: "GET",
      url: "/v1/refunds?status=failed",
      headers: withAuth(),
    });
    expect(byStatus.statusCode).toBe(200);
    expect(byStatus.json().data.length).toBe(1);
    expect(byStatus.json().data[0].status).toBe("failed");

    const byPaymentIntent = await app.inject({
      method: "GET",
      url: `/v1/refunds?payment_intent_id=${succeededPaymentIntentId}`,
      headers: withAuth(),
    });
    expect(byPaymentIntent.statusCode).toBe(200);
    expect(byPaymentIntent.json().data.length).toBe(1);
    expect(byPaymentIntent.json().data[0].payment_intent_id).toBe(succeededPaymentIntentId);

    const byAmountRange = await app.inject({
      method: "GET",
      url: "/v1/refunds?amount_min=1000&amount_max=1500",
      headers: withAuth(),
    });
    expect(byAmountRange.statusCode).toBe(200);
    expect(byAmountRange.json().data.length).toBe(1);
    expect(byAmountRange.json().data[0].amount).toBe(1200);
  });

  it("rejects invalid refund list filters", async () => {
    const invalidStatus = await app.inject({
      method: "GET",
      url: "/v1/refunds?status=invalid",
      headers: withAuth(),
    });
    expect(invalidStatus.statusCode).toBe(422);
    expect(invalidStatus.json().error.code).toBe("invalid_refund_status");

    const invalidCreatedFrom = await app.inject({
      method: "GET",
      url: "/v1/refunds?created_from=invalid-date",
      headers: withAuth(),
    });
    expect(invalidCreatedFrom.statusCode).toBe(422);
    expect(invalidCreatedFrom.json().error.code).toBe("invalid_created_from");

    const invalidAmountMin = await app.inject({
      method: "GET",
      url: "/v1/refunds?amount_min=zero",
      headers: withAuth(),
    });
    expect(invalidAmountMin.statusCode).toBe(422);
    expect(invalidAmountMin.json().error.code).toBe("invalid_amount_min");

    const invalidAmountRange = await app.inject({
      method: "GET",
      url: "/v1/refunds?amount_min=2000&amount_max=1000",
      headers: withAuth(),
    });
    expect(invalidAmountRange.statusCode).toBe(422);
    expect(invalidAmountRange.json().error.code).toBe("invalid_amount_range");

    const invalidRange = await app.inject({
      method: "GET",
      url: "/v1/refunds?created_from=2026-12-31T00:00:00.000Z&created_to=2026-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidRange.statusCode).toBe(422);
    expect(invalidRange.json().error.code).toBe("invalid_created_range");
  });

  it("lists ledger entries with cursor pagination and filters", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("ledger-list-create"),
      payload: {
        amount: 5200,
        currency: "BRL",
        customer: { id: "cus_ledger_list" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id as string;

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("ledger-list-confirm"),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("succeeded");

    const refund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("ledger-list-refund"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 1700,
      },
    });
    expect(refund.statusCode).toBe(201);
    expect(refund.json().status).toBe("succeeded");

    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/ledger-entries?payment_intent_id=${paymentIntentId}&limit=2`,
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string; entry_type: string; direction: string; payment_intent_id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();
    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(2);
    expect(firstPageBody.pagination.limit).toBe(2);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(firstPageBody.data.every((item) => item.payment_intent_id === paymentIntentId)).toBe(true);

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/ledger-entries?payment_intent_id=${paymentIntentId}&limit=2&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string; entry_type: string; direction: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();
    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();

    const allEntryTypes = [...firstPageBody.data, ...secondPageBody.data].map((item) => item.entry_type);
    expect(allEntryTypes.filter((type) => type === "authorization")).toHaveLength(1);
    expect(allEntryTypes.filter((type) => type === "capture")).toHaveLength(1);
    expect(allEntryTypes.filter((type) => type === "refund")).toHaveLength(1);

    const debitOnly = await app.inject({
      method: "GET",
      url: `/v1/ledger-entries?payment_intent_id=${paymentIntentId}&direction=debit`,
      headers: withAuth(),
    });
    expect(debitOnly.statusCode).toBe(200);
    expect(debitOnly.json().data).toHaveLength(1);
    expect(debitOnly.json().data[0].entry_type).toBe("refund");
    expect(debitOnly.json().data[0].direction).toBe("debit");

    const captureOnly = await app.inject({
      method: "GET",
      url: `/v1/ledger-entries?payment_intent_id=${paymentIntentId}&entry_type=capture`,
      headers: withAuth(),
    });
    expect(captureOnly.statusCode).toBe(200);
    expect(captureOnly.json().data).toHaveLength(1);
    expect(captureOnly.json().data[0].entry_type).toBe("capture");
    expect(captureOnly.json().data[0].direction).toBe("credit");
  });

  it("rejects invalid ledger list filters", async () => {
    const invalidType = await app.inject({
      method: "GET",
      url: "/v1/ledger-entries?entry_type=invalid",
      headers: withAuth(),
    });
    expect(invalidType.statusCode).toBe(422);
    expect(invalidType.json().error.code).toBe("invalid_ledger_entry_type");

    const invalidDirection = await app.inject({
      method: "GET",
      url: "/v1/ledger-entries?direction=invalid",
      headers: withAuth(),
    });
    expect(invalidDirection.statusCode).toBe(422);
    expect(invalidDirection.json().error.code).toBe("invalid_ledger_direction");

    const invalidAmountRange = await app.inject({
      method: "GET",
      url: "/v1/ledger-entries?amount_min=5000&amount_max=1000",
      headers: withAuth(),
    });
    expect(invalidAmountRange.statusCode).toBe(422);
    expect(invalidAmountRange.json().error.code).toBe("invalid_amount_range");

    const invalidCreatedRange = await app.inject({
      method: "GET",
      url: "/v1/ledger-entries?created_from=2026-12-31T00:00:00.000Z&created_to=2026-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidCreatedRange.statusCode).toBe(422);
    expect(invalidCreatedRange.json().error.code).toBe("invalid_created_range");
  });

  it("lists payment events with cursor pagination and filters", async () => {
    const createA = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("events-list-create-a"),
      payload: {
        amount: 2200,
        currency: "BRL",
        customer: { id: "cus_events_a" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentA = createA.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentA}/confirm`,
      headers: withAuthAndIdempotency("events-list-confirm-a"),
    });

    const createB = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("events-list-create-b"),
      payload: {
        amount: 2300,
        currency: "BRL",
        customer: { id: "cus_events_b" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentB = createB.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentB}/confirm`,
      headers: withAuthAndIdempotency("events-list-confirm-b"),
    });

    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/payment-events?payment_intent_id=${paymentIntentA}&limit=2`,
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string; data: { payment_intent_id?: string } }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();
    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(2);
    expect(firstPageBody.pagination.limit).toBe(2);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(
      firstPageBody.data.every((event) => event.data.payment_intent_id === paymentIntentA),
    ).toBe(true);

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/payment-events?payment_intent_id=${paymentIntentA}&limit=2&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string; data: { payment_intent_id?: string } }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();
    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    expect(
      secondPageBody.data.every((event) => event.data.payment_intent_id === paymentIntentA),
    ).toBe(true);

    const succeededOnly = await app.inject({
      method: "GET",
      url: `/v1/payment-events?payment_intent_id=${paymentIntentA}&event_type=payment_intent.succeeded`,
      headers: withAuth(),
    });
    expect(succeededOnly.statusCode).toBe(200);
    expect(succeededOnly.json().data.length).toBe(1);
    expect(succeededOnly.json().data[0].type).toBe("payment_intent.succeeded");

    const futureWindow = await app.inject({
      method: "GET",
      url: "/v1/payment-events?occurred_from=2099-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(futureWindow.statusCode).toBe(200);
    expect(futureWindow.json().data.length).toBe(0);
  });

  it("rejects invalid payment-events list filters", async () => {
    const invalidEventType = await app.inject({
      method: "GET",
      url: "/v1/payment-events?event_type=unknown.event",
      headers: withAuth(),
    });
    expect(invalidEventType.statusCode).toBe(422);
    expect(invalidEventType.json().error.code).toBe("invalid_webhook_event_type");

    const invalidOccurredFrom = await app.inject({
      method: "GET",
      url: "/v1/payment-events?occurred_from=not-a-date",
      headers: withAuth(),
    });
    expect(invalidOccurredFrom.statusCode).toBe(422);
    expect(invalidOccurredFrom.json().error.code).toBe("invalid_occurred_from");

    const invalidRange = await app.inject({
      method: "GET",
      url: "/v1/payment-events?occurred_from=2026-12-31T00:00:00.000Z&occurred_to=2026-01-01T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidRange.statusCode).toBe(422);
    expect(invalidRange.json().error.code).toBe("invalid_occurred_range");
  });

  it("falls back to secondary provider on transient authorization failure", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("failover-1"),
      payload: {
        amount: 2500,
        currency: "BRL",
        customer: { id: "cus_failover" },
        payment_method: { type: "card", token: "tok_test_transient" },
        capture_method: "automatic",
      },
    });

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/confirm`,
      headers: withAuthAndIdempotency("failover-confirm-1"),
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("succeeded");
    expect(confirm.json().provider).toBe("provider_a");
    expect(confirm.json().provider_reference).toBeTypeOf("string");
  });

  it("blocks payment when risk engine denies transaction", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("risk-deny-1"),
      payload: {
        amount: 3000,
        currency: "BRL",
        customer: { id: "blocked_001" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/confirm`,
      headers: withAuthAndIdempotency("risk-deny-confirm-1"),
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("failed");
  });

  it("moves payment to requires_action when risk engine requests review", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("risk-review-1"),
      payload: {
        amount: 1000000,
        currency: "BRL",
        customer: { id: "cus_high_value" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/confirm`,
      headers: withAuthAndIdempotency("risk-review-confirm-1"),
    });

    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("requires_action");
  });

  it("registers webhook endpoint and lists endpoints", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-a/orders",
        events: ["payment_intent.succeeded"],
      },
    });

    expect(register.statusCode).toBe(201);
    expect(register.json().id).toBeTypeOf("string");
    expect(register.json().secret).toContain("whsec_");

    const list = await app.inject({
      method: "GET",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBe(1);
    expect(list.json().data[0].url).toBe("memory://merchant-a/orders");
    expect(list.json().pagination.limit).toBe(50);
    expect(list.json().pagination.has_more).toBe(false);
    expect(list.json().pagination.next_cursor).toBeNull();
  });

  it("rotates webhook endpoint secret", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-rotate/orders",
        events: ["payment_intent.succeeded"],
        secret: "whsec_initial_secret_123",
      },
    });
    expect(register.statusCode).toBe(201);

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/webhook-endpoints/${register.json().id}/rotate-secret`,
      headers: withAuth(),
      payload: {
        secret: "whsec_rotated_secret_456",
      },
    });

    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().id).toBe(register.json().id);
    expect(rotated.json().secret).toBe("whsec_rotated_secret_456");
    expect(rotated.json().secret).not.toBe(register.json().secret);
  });

  it("updates webhook endpoint fields", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-update/orders",
        events: ["payment_intent.created"],
        enabled: true,
      },
    });
    expect(register.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
      payload: {
        url: "memory://merchant-update-v2/orders",
        events: ["refund.failed"],
        enabled: false,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().url).toBe("memory://merchant-update-v2/orders");
    expect(updated.json().enabled).toBe(false);
    expect(updated.json().events).toEqual(["refund.failed"]);
  });

  it("gets webhook endpoint by id with ETag header", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-get-by-id/orders",
        events: ["payment_intent.created"],
      },
    });
    expect(register.statusCode).toBe(201);

    const found = await app.inject({
      method: "GET",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
    });

    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(register.json().id);
    expect(typeof found.headers.etag).toBe("string");
    expect(found.headers.etag).toMatch(/^"[^"]+"$/);
  });

  it("updates webhook endpoint with If-Match precondition", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-if-match/orders",
        enabled: true,
      },
    });
    expect(register.statusCode).toBe(201);

    const current = await app.inject({
      method: "GET",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
    });
    const etag = current.headers.etag;
    expect(typeof etag).toBe("string");

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth({ "If-Match": String(etag) }),
      payload: {
        enabled: false,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().enabled).toBe(false);
    expect(updated.headers.etag).toBeTypeOf("string");
    expect(updated.headers.etag).not.toBe(etag);
  });

  it("returns 412 when If-Match uses stale ETag on webhook endpoint update", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-if-match-stale/orders",
      },
    });
    expect(register.statusCode).toBe(201);

    const current = await app.inject({
      method: "GET",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
    });
    const firstEtag = current.headers.etag;
    expect(typeof firstEtag).toBe("string");

    const firstUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth({ "If-Match": String(firstEtag) }),
      payload: {
        enabled: false,
      },
    });
    expect(firstUpdate.statusCode).toBe(200);

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth({ "If-Match": String(firstEtag) }),
      payload: {
        enabled: true,
      },
    });
    expect(staleUpdate.statusCode).toBe(412);
    expect(staleUpdate.json().error.code).toBe("precondition_failed");
  });

  it("rejects invalid If-Match format", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-if-match-invalid/orders",
      },
    });
    expect(register.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth({ "If-Match": "invalid-etag" }),
      payload: {
        enabled: false,
      },
    });
    expect(updated.statusCode).toBe(422);
    expect(updated.json().error.code).toBe("invalid_if_match");
  });

  it("rejects webhook endpoint update with empty payload", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-update-empty/orders",
      },
    });
    expect(register.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
      payload: {},
    });

    expect(updated.statusCode).toBe(422);
    expect(updated.json().error.code).toBe("invalid_webhook_update");
  });

  it("does not deliver webhooks after endpoint is disabled via patch", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-disabled/orders",
        events: ["payment_intent.created"],
      },
    });
    expect(register.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${register.json().id}`,
      headers: withAuth(),
      payload: {
        enabled: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().enabled).toBe(false);

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("webhook-disabled-create"),
      payload: {
        amount: 2100,
        currency: "BRL",
        customer: { id: "cus_webhook_disabled" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().data.length).toBe(0);
  });

  it("rejects webhook endpoint update for unknown endpoint", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: "/v1/webhook-endpoints/we_missing",
      headers: withAuth(),
      payload: {
        enabled: false,
      },
    });

    expect(updated.statusCode).toBe(404);
    expect(updated.json().error.code).toBe("resource_not_found");
  });

  it("rejects webhook secret rotation for unknown endpoint", async () => {
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints/we_missing/rotate-secret",
      headers: withAuth(),
      payload: {
        secret: "whsec_rotated_secret_456",
      },
    });

    expect(rotated.statusCode).toBe(404);
    expect(rotated.json().error.code).toBe("resource_not_found");
  });

  it("rejects invalid payload when rotating webhook secret", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-rotate-invalid/orders",
      },
    });
    expect(register.statusCode).toBe(201);

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/webhook-endpoints/${register.json().id}/rotate-secret`,
      headers: withAuth(),
      payload: {
        secret: "",
      },
    });

    expect(rotated.statusCode).toBe(422);
    expect(rotated.json().error.code).toBe("invalid_webhook_secret");
  });

  it("supports cursor pagination for webhook endpoints", async () => {
    for (const suffix of ["one", "two", "three"]) {
      await app.inject({
        method: "POST",
        url: "/v1/webhook-endpoints",
        headers: withAuth(),
        payload: {
          url: `memory://merchant-${suffix}/orders`,
          events: ["payment_intent.succeeded"],
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/webhook-endpoints?limit=2",
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();

    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(2);
    expect(firstPageBody.pagination.limit).toBe(2);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const firstPageIds = new Set<string>(firstPageBody.data.map((item) => item.id));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/webhook-endpoints?limit=2&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();

    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    const secondPageFirstItem = secondPageBody.data.at(0);
    expect(secondPageFirstItem).toBeDefined();
    if (!secondPageFirstItem) {
      throw new Error("Expected at least one webhook endpoint in second page.");
    }
    expect(firstPageIds.has(secondPageFirstItem.id)).toBe(false);
  });

  it("delivers webhook for subscribed succeeded event", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-success/orders",
        events: ["payment_intent.succeeded"],
      },
    });

    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("webhook-success-create"),
      payload: {
        amount: 2190,
        currency: "BRL",
        customer: { id: "cus_webhook" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/confirm`,
      headers: withAuthAndIdempotency("webhook-success-confirm"),
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().pagination.limit).toBe(50);
    const delivered = deliveries
      .json()
      .data.find((item: { event_type: string; status: string }) => item.event_type === "payment_intent.succeeded");
    expect(delivered).toBeDefined();
    expect(delivered.status).toBe("succeeded");
  });

  it("retries webhook delivery when endpoint is unavailable", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/merchant-b",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("webhook-retry-create"),
      payload: {
        amount: 1900,
        currency: "BRL",
        customer: { id: "cus_retry" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    const attempts = deliveries
      .json()
      .data.filter((item: { event_type: string; status: string }) => item.event_type === "payment_intent.created");
    expect(attempts.length).toBe(3);
    expect(attempts.every((item: { status: string }) => item.status === "failed")).toBe(true);
  });

  it("does not retry webhook delivery for permanent 4xx failures", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/merchant-c",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("webhook-permanent-failure-create"),
      payload: {
        amount: 2100,
        currency: "BRL",
        customer: { id: "cus_permanent_webhook" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    const attempts = deliveries
      .json()
      .data.filter((item: { event_type: string; status: string }) => item.event_type === "payment_intent.created");
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].response_status).toBe(400);
  });

  it("retries webhook delivery for 429 rate limit", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://rate-limit/merchant-d",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("webhook-rate-limit-create"),
      payload: {
        amount: 2200,
        currency: "BRL",
        customer: { id: "cus_rate_limit" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    const attempts = deliveries
      .json()
      .data.filter((item: { event_type: string }) => item.event_type === "payment_intent.created");
    expect(attempts.length).toBe(3);
    expect(attempts[0].status).toBe("succeeded");
    expect(attempts[0].response_status).toBe(200);
  });

  it("supports cursor pagination for webhook deliveries", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/paginated-merchant",
        events: ["payment_intent.created"],
      },
    });

    for (const key of ["pagination-deliveries-create-1", "pagination-deliveries-create-2"]) {
      await app.inject({
        method: "POST",
        url: "/v1/payment-intents",
        headers: withAuthAndIdempotency(key),
        payload: {
          amount: 1950,
          currency: "BRL",
          customer: { id: `cus_${key}` },
          payment_method: { type: "pix", token: "tok_test_pix" },
          capture_method: "automatic",
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries?limit=4",
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();

    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(4);
    expect(firstPageBody.pagination.limit).toBe(4);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const firstPageIds = new Set<string>(firstPageBody.data.map((item) => item.id));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/webhook-deliveries?limit=4&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();

    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(2);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    const secondPageFirstItem = secondPageBody.data.at(0);
    expect(secondPageFirstItem).toBeDefined();
    if (!secondPageFirstItem) {
      throw new Error("Expected at least one webhook delivery in second page.");
    }
    expect(firstPageIds.has(secondPageFirstItem.id)).toBe(false);
  });

  it("stores dead letter when webhook exhausts max retry attempts", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-merchant",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-create-1"),
      payload: {
        amount: 2050,
        currency: "BRL",
        customer: { id: "cus_dead_letter_1" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLetters = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });

    expect(deadLetters.statusCode).toBe(200);
    expect(deadLetters.json().data.length).toBe(1);
    expect(deadLetters.json().data[0].event_type).toBe("payment_intent.created");
    expect(deadLetters.json().data[0].failure_reason).toBe("max_attempts_exhausted");
    expect(deadLetters.json().data[0].attempts).toBe(3);
    expect(deadLetters.json().data[0].status).toBe("pending");
    expect(deadLetters.json().data[0].replay_count).toBe(0);
    expect(deadLetters.json().pagination.limit).toBe(50);
  });

  it("stores dead letter with permanent_failure when webhook returns 4xx", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-merchant",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-create-2"),
      payload: {
        amount: 1990,
        currency: "BRL",
        customer: { id: "cus_dead_letter_2" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLetters = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });

    expect(deadLetters.statusCode).toBe(200);
    expect(deadLetters.json().data.length).toBe(1);
    expect(deadLetters.json().data[0].failure_reason).toBe("permanent_failure");
    expect(deadLetters.json().data[0].attempts).toBe(1);
    expect(deadLetters.json().data[0].status).toBe("pending");
    expect(deadLetters.json().data[0].replay_count).toBe(0);
    expect(deadLetters.json().data[0].response_status).toBe(400);
  });

  it("replays dead letter and marks it as replayed", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-replay-ok",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-replay-create-1"),
      payload: {
        amount: 2150,
        currency: "BRL",
        customer: { id: "cus_dead_letter_replay_1" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLettersBeforeReplay = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });
    const deadLetterId = deadLettersBeforeReplay.json().data[0].id;

    await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: withAuth(),
      payload: {
        url: "memory://merchant-replay-ok/orders",
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("replayed");
    expect(replay.json().replay_count).toBe(1);
    expect(replay.json().last_replayed_at).toBeTypeOf("string");
  });

  it("keeps dead letter pending when replay attempt fails", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-replay-fail",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-replay-create-2"),
      payload: {
        amount: 2190,
        currency: "BRL",
        customer: { id: "cus_dead_letter_replay_2" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLettersBeforeReplay = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });
    const deadLetterId = deadLettersBeforeReplay.json().data[0].id;

    const replay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("pending");
    expect(replay.json().replay_count).toBe(1);
    expect(replay.json().attempts).toBe(4);
  });

  it("returns conflict when replaying dead letter already replayed", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-replay-conflict",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-replay-create-3"),
      payload: {
        amount: 2290,
        currency: "BRL",
        customer: { id: "cus_dead_letter_replay_3" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLettersBeforeReplay = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });
    const deadLetterId = deadLettersBeforeReplay.json().data[0].id;

    await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: withAuth(),
      payload: {
        url: "memory://merchant-replay-conflict/orders",
      },
    });

    const firstReplay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });
    expect(firstReplay.statusCode).toBe(200);
    expect(firstReplay.json().status).toBe("replayed");

    const secondReplay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });
    expect(secondReplay.statusCode).toBe(409);
    expect(secondReplay.json().error.code).toBe("dead_letter_already_replayed");
  });

  it("returns conflict when replaying dead letter for disabled endpoint", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-replay-disabled",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-replay-create-4"),
      payload: {
        amount: 2390,
        currency: "BRL",
        customer: { id: "cus_dead_letter_replay_4" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLettersBeforeReplay = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });
    const deadLetterId = deadLettersBeforeReplay.json().data[0].id;

    await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: withAuth(),
      payload: {
        enabled: false,
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("webhook_endpoint_disabled");
  });

  it("replays dead letters in batch with endpoint filter", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-batch-replay",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-batch-replay-create"),
      payload: {
        amount: 2410,
        currency: "BRL",
        customer: { id: "cus_dead_letter_batch_replay" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: withAuth(),
      payload: {
        url: "memory://merchant-batch-replay-ok/orders",
      },
    });

    const replayBatch = await app.inject({
      method: "POST",
      url: "/v1/webhook-dead-letters/replay-batch",
      headers: withAuth(),
      payload: {
        endpoint_id: endpointId,
        event_type: "payment_intent.created",
        limit: 10,
      },
    });

    expect(replayBatch.statusCode).toBe(200);
    expect(replayBatch.json().summary.processed).toBe(1);
    expect(replayBatch.json().summary.replayed).toBe(1);
    expect(replayBatch.json().summary.failed).toBe(0);
    expect(replayBatch.json().summary.has_more).toBe(false);
    expect(replayBatch.json().data[0].outcome).toBe("replayed");
  });

  it("returns failed items in replay-batch and increments attempts sequentially", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-batch-fail",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-batch-fail-create"),
      payload: {
        amount: 2420,
        currency: "BRL",
        customer: { id: "cus_dead_letter_batch_fail" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const firstBatch = await app.inject({
      method: "POST",
      url: "/v1/webhook-dead-letters/replay-batch",
      headers: withAuth(),
      payload: {
        endpoint_id: endpointId,
        limit: 10,
      },
    });
    expect(firstBatch.statusCode).toBe(200);
    expect(firstBatch.json().summary.failed).toBe(1);
    expect(firstBatch.json().data[0].outcome).toBe("failed");

    const secondBatch = await app.inject({
      method: "POST",
      url: "/v1/webhook-dead-letters/replay-batch",
      headers: withAuth(),
      payload: {
        endpoint_id: endpointId,
        limit: 10,
      },
    });
    expect(secondBatch.statusCode).toBe(200);

    const deadLetters = await app.inject({
      method: "GET",
      url: `/v1/webhook-dead-letters?endpoint_id=${endpointId}`,
      headers: withAuth(),
    });
    expect(deadLetters.statusCode).toBe(200);
    expect(deadLetters.json().data.length).toBe(1);
    expect(deadLetters.json().data[0].attempts).toBe(5);
  });

  it("rejects invalid replay-batch payload", async () => {
    const invalidLimit = await app.inject({
      method: "POST",
      url: "/v1/webhook-dead-letters/replay-batch",
      headers: withAuth(),
      payload: {
        limit: 0,
      },
    });
    expect(invalidLimit.statusCode).toBe(422);
    expect(invalidLimit.json().error.code).toBe("invalid_replay_batch");

    const invalidStatus = await app.inject({
      method: "POST",
      url: "/v1/webhook-dead-letters/replay-batch",
      headers: withAuth(),
      payload: {
        status: "done",
      },
    });
    expect(invalidStatus.statusCode).toBe(422);
    expect(invalidStatus.json().error.code).toBe("invalid_replay_batch");
  });

  it("gets webhook dead letter by id", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-get-by-id",
        events: ["payment_intent.created"],
      },
    });

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-get-by-id-create"),
      payload: {
        amount: 2490,
        currency: "BRL",
        customer: { id: "cus_dead_letter_get_by_id" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters",
      headers: withAuth(),
    });
    const deadLetterId = list.json().data[0].id;

    const found = await app.inject({
      method: "GET",
      url: `/v1/webhook-dead-letters/${deadLetterId}`,
      headers: withAuth(),
    });

    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(deadLetterId);
    expect(found.json().status).toBe("pending");
    expect(found.json().event_type).toBe("payment_intent.created");
  });

  it("filters dead letters by status", async () => {
    const endpoint = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://bad-request/dead-letter-filter-status",
        events: ["payment_intent.created"],
      },
    });
    const endpointId = endpoint.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-filter-status-create"),
      payload: {
        amount: 2590,
        currency: "BRL",
        customer: { id: "cus_dead_letter_filter_status" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const deadLettersBeforeReplay = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters?status=pending",
      headers: withAuth(),
    });
    expect(deadLettersBeforeReplay.statusCode).toBe(200);
    expect(deadLettersBeforeReplay.json().data.length).toBe(1);
    const deadLetterId = deadLettersBeforeReplay.json().data[0].id;

    await app.inject({
      method: "PATCH",
      url: `/v1/webhook-endpoints/${endpointId}`,
      headers: withAuth(),
      payload: {
        url: "memory://merchant-filter-status-ok/orders",
      },
    });

    const replay = await app.inject({
      method: "POST",
      url: `/v1/webhook-dead-letters/${deadLetterId}/replay`,
      headers: withAuth(),
    });
    expect(replay.statusCode).toBe(200);

    const replayedOnly = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters?status=replayed",
      headers: withAuth(),
    });
    expect(replayedOnly.statusCode).toBe(200);
    expect(replayedOnly.json().data.length).toBe(1);
    expect(replayedOnly.json().data[0].status).toBe("replayed");
  });

  it("filters dead letters by endpoint_id and event_type", async () => {
    const endpointA = await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-filter-a",
        events: ["payment_intent.created"],
      },
    });
    const endpointAId = endpointA.json().id;

    await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("dead-letter-filter-a-create"),
      payload: {
        amount: 2690,
        currency: "BRL",
        customer: { id: "cus_dead_letter_filter_a" },
        payment_method: { type: "pix", token: "tok_test_pix" },
        capture_method: "automatic",
      },
    });

    const filtered = await app.inject({
      method: "GET",
      url: `/v1/webhook-dead-letters?endpoint_id=${endpointAId}&event_type=payment_intent.created`,
      headers: withAuth(),
    });

    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().data.length).toBe(1);
    expect(filtered.json().data[0].endpoint_id).toBe(endpointAId);
    expect(filtered.json().data[0].event_type).toBe("payment_intent.created");
  });

  it("rejects invalid dead-letter filter values", async () => {
    const badStatus = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters?status=invalid",
      headers: withAuth(),
    });
    expect(badStatus.statusCode).toBe(422);
    expect(badStatus.json().error.code).toBe("invalid_dead_letter_status");

    const badEventType = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters?event_type=unknown.event",
      headers: withAuth(),
    });
    expect(badEventType.statusCode).toBe(422);
    expect(badEventType.json().error.code).toBe("invalid_webhook_event_type");
  });

  it("supports cursor pagination for webhook dead letters", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://always-fail/dead-letter-pagination",
        events: ["payment_intent.created"],
      },
    });

    for (const key of ["dead-letter-pagination-1", "dead-letter-pagination-2"]) {
      await app.inject({
        method: "POST",
        url: "/v1/payment-intents",
        headers: withAuthAndIdempotency(key),
        payload: {
          amount: 1990,
          currency: "BRL",
          customer: { id: `cus_${key}` },
          payment_method: { type: "pix", token: "tok_test_pix" },
          capture_method: "automatic",
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/webhook-dead-letters?limit=1",
      headers: withAuth(),
    });
    const firstPageBody = firstPage.json<{
      data: Array<{ id: string }>;
      pagination: { limit: number; has_more: boolean; next_cursor: string | null };
    }>();
    expect(firstPage.statusCode).toBe(200);
    expect(firstPageBody.data.length).toBe(1);
    expect(firstPageBody.pagination.limit).toBe(1);
    expect(firstPageBody.pagination.has_more).toBe(true);
    expect(firstPageBody.pagination.next_cursor).toBeTypeOf("string");
    expect(firstPageBody.pagination.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const firstPageIds = new Set<string>(firstPageBody.data.map((item) => item.id));
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/webhook-dead-letters?limit=1&cursor=${firstPageBody.pagination.next_cursor}`,
      headers: withAuth(),
    });
    const secondPageBody = secondPage.json<{
      data: Array<{ id: string }>;
      pagination: { has_more: boolean; next_cursor: string | null };
    }>();
    expect(secondPage.statusCode).toBe(200);
    expect(secondPageBody.data.length).toBe(1);
    expect(secondPageBody.pagination.has_more).toBe(false);
    expect(secondPageBody.pagination.next_cursor).toBeNull();
    const secondPageFirstItem = secondPageBody.data.at(0);
    expect(secondPageFirstItem).toBeDefined();
    if (!secondPageFirstItem) {
      throw new Error("Expected at least one webhook dead letter in second page.");
    }
    expect(firstPageIds.has(secondPageFirstItem.id)).toBe(false);
  });

  it("rejects invalid pagination cursor format", async () => {
    const deliveriesResponse = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries?cursor=bad cursor value",
      headers: withAuth(),
    });
    const intentsResponse = await app.inject({
      method: "GET",
      url: "/v1/payment-intents?cursor=bad cursor value",
      headers: withAuth(),
    });
    const refundsResponse = await app.inject({
      method: "GET",
      url: "/v1/refunds?cursor=bad cursor value",
      headers: withAuth(),
    });
    const eventsResponse = await app.inject({
      method: "GET",
      url: "/v1/payment-events?cursor=bad cursor value",
      headers: withAuth(),
    });
    const ledgerResponse = await app.inject({
      method: "GET",
      url: "/v1/ledger-entries?cursor=bad cursor value",
      headers: withAuth(),
    });

    expect(deliveriesResponse.statusCode).toBe(422);
    expect(deliveriesResponse.json().error.code).toBe("invalid_cursor");
    expect(intentsResponse.statusCode).toBe(422);
    expect(intentsResponse.json().error.code).toBe("invalid_cursor");
    expect(refundsResponse.statusCode).toBe(422);
    expect(refundsResponse.json().error.code).toBe("invalid_cursor");
    expect(eventsResponse.statusCode).toBe(422);
    expect(eventsResponse.json().error.code).toBe("invalid_cursor");
    expect(ledgerResponse.statusCode).toBe(422);
    expect(ledgerResponse.json().error.code).toBe("invalid_cursor");
  });

  it("rejects signed pagination cursor that does not exist", async () => {
    const cursorTokens = new CursorTokenService("dev_cursor_secret_change_me_2026");
    const missingCursor = cursorTokens.encode("we_missing_cursor");
    const response = await app.inject({
      method: "GET",
      url: `/v1/webhook-endpoints?cursor=${missingCursor}`,
      headers: withAuth(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("invalid_cursor");
  });

  it("accepts cursor token signed with previous secret during rotation", async () => {
    const rotatingApp = buildApp({
      host: "0.0.0.0",
      port: 8080,
      apiKey: "dev_pmc_key",
      apiKeys: ["dev_pmc_key"],
      cursorSecret: "new_cursor_secret_123456",
      cursorVerificationSecrets: ["new_cursor_secret_123456", "old_cursor_secret_123456"],
      idempotencyKeyMaxLength: 128,
      idempotencyTtlSeconds: 86400,
      listDefaultLimit: 50,
      listMaxLimit: 500,
      eventApiVersion: "2026-02-08",
      eventSource: "payment-module-core",
      eventSchemaVersion: "1.0.0",
      riskReviewAmountThreshold: 1_000_000,
      webhookMaxAttempts: 3,
      webhookTimeoutMs: 5000,
      providerCircuitBreakerEnabled: true,
      providerCircuitBreakerFailureThreshold: 3,
      providerCircuitBreakerCooldownSeconds: 30,
      providerCircuitBreakerTransientOnly: true,
      metricsEnabled: true,
      rateLimitEnabled: true,
      rateLimitWindowSeconds: 1,
      rateLimitMaxRequests: 1000,
    });
    await rotatingApp.ready();

    try {
      for (const suffix of ["legacy-one", "legacy-two", "legacy-three"]) {
        await rotatingApp.inject({
          method: "POST",
          url: "/v1/webhook-endpoints",
          headers: withAuth(),
          payload: {
            url: `memory://merchant-${suffix}/orders`,
            events: ["payment_intent.succeeded"],
          },
        });
      }

      const firstPage = await rotatingApp.inject({
        method: "GET",
        url: "/v1/webhook-endpoints?limit=2",
        headers: withAuth(),
      });
      const firstPageBody = firstPage.json<{
        data: Array<{ id: string }>;
      }>();
      expect(firstPage.statusCode).toBe(200);
      expect(firstPageBody.data.length).toBe(2);
      const secondItem = firstPageBody.data.at(1);
      expect(secondItem).toBeDefined();
      if (!secondItem) {
        throw new Error("Expected second item in first page for legacy cursor generation.");
      }

      const previousSecretTokens = new CursorTokenService("old_cursor_secret_123456");
      const legacyCursor = previousSecretTokens.encode(secondItem.id);

      const secondPage = await rotatingApp.inject({
        method: "GET",
        url: `/v1/webhook-endpoints?limit=2&cursor=${legacyCursor}`,
        headers: withAuth(),
      });

      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().data.length).toBe(1);
    } finally {
      await rotatingApp.close();
    }
  });

  it("replays idempotent confirm with the same key", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("confirm-idem-create"),
      payload: {
        amount: 1900,
        currency: "BRL",
        customer: { id: "cus_confirm_idem" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const paymentIntentId = create.json().id;
    const first = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("confirm-idem-1"),
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("confirm-idem-1"),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["x-idempotency-replayed"]).toBe("false");
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(second.json().status).toBe(first.json().status);
  });

  it("rejects capture idempotency key reuse with different payload", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("capture-idem-create"),
      payload: {
        amount: 7000,
        currency: "BRL",
        customer: { id: "cus_capture_idem" },
        payment_method: { type: "card", token: "tok_test_manual" },
        capture_method: "manual",
      },
    });
    const paymentIntentId = create.json().id;

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("capture-idem-confirm"),
    });

    const firstCapture = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/capture`,
      headers: withAuthAndIdempotency("capture-idem-1"),
      payload: { amount: 3000 },
    });
    expect(firstCapture.statusCode).toBe(200);

    const secondCaptureConflict = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/capture`,
      headers: withAuthAndIdempotency("capture-idem-1"),
      payload: { amount: 5000 },
    });

    expect(secondCaptureConflict.statusCode).toBe(409);
    expect(secondCaptureConflict.json().error.code).toBe("idempotency_conflict");
  });

  it("emits and delivers refund.failed event", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-refund-failed/orders",
        events: ["refund.failed"],
      },
    });

    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("refund-failed-create"),
      payload: {
        amount: 3000,
        currency: "BRL",
        customer: { id: "cus_refund_failed" },
        payment_method: { type: "card", token: "tok_test_refund_fail" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id;

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("refund-failed-confirm"),
    });

    const refund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("refund-failed-refund"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 1000,
      },
    });

    expect(refund.statusCode).toBe(201);
    expect(refund.json().status).toBe("failed");

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    const refundFailedDelivery = deliveries
      .json()
      .data.find((item: { event_type: string; status: string }) => item.event_type === "refund.failed");
    expect(refundFailedDelivery).toBeDefined();
    expect(refundFailedDelivery.status).toBe("succeeded");
  });

  it("cancels a payment intent before confirmation", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("cancel-before-confirm-create"),
      payload: {
        amount: 1300,
        currency: "BRL",
        customer: { id: "cus_cancel_before_confirm" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    const canceled = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/cancel`,
      headers: withAuthAndIdempotency("cancel-before-confirm-cancel"),
    });

    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe("canceled");
  });

  it("replays idempotent cancel with same key", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("cancel-idem-create"),
      payload: {
        amount: 1700,
        currency: "BRL",
        customer: { id: "cus_cancel_idem" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id;

    const first = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/cancel`,
      headers: withAuthAndIdempotency("cancel-idem-1"),
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/cancel`,
      headers: withAuthAndIdempotency("cancel-idem-1"),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["x-idempotency-replayed"]).toBe("false");
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(second.json().status).toBe("canceled");
  });

  it("rejects cancel for succeeded payments", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("cancel-succeeded-create"),
      payload: {
        amount: 2500,
        currency: "BRL",
        customer: { id: "cus_cancel_succeeded" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id;

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("cancel-succeeded-confirm"),
    });

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/cancel`,
      headers: withAuthAndIdempotency("cancel-succeeded-cancel"),
    });

    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe("invalid_payment_state");
  });

  it("delivers payment_intent.canceled webhook event", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: withAuth(),
      payload: {
        url: "memory://merchant-canceled/orders",
        events: ["payment_intent.canceled"],
      },
    });

    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("cancel-webhook-create"),
      payload: {
        amount: 1800,
        currency: "BRL",
        customer: { id: "cus_cancel_webhook" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${create.json().id}/cancel`,
      headers: withAuthAndIdempotency("cancel-webhook-cancel"),
    });

    const deliveries = await app.inject({
      method: "GET",
      url: "/v1/webhook-deliveries",
      headers: withAuth(),
    });

    const canceledDelivery = deliveries
      .json()
      .data.find(
        (item: { event_type: string; status: string }) => item.event_type === "payment_intent.canceled",
      );
    expect(canceledDelivery).toBeDefined();
    expect(canceledDelivery.status).toBe("succeeded");
  });

  it("creates and resolves chargeback, recording ledger and events", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("chargeback-flow-create"),
      payload: {
        amount: 10000,
        currency: "BRL",
        customer: { id: "cus_chargeback_flow" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id as string;

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("chargeback-flow-confirm"),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("succeeded");

    const chargebackCreatePayload = {
      payment_intent_id: paymentIntentId,
      amount: 2200,
      reason: "fraud",
      evidence_url: "https://merchant.local/evidence/123",
    };
    const opened = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuthAndIdempotency("chargeback-open-1"),
      payload: chargebackCreatePayload,
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().status).toBe("open");

    const openedReplay = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuthAndIdempotency("chargeback-open-1"),
      payload: chargebackCreatePayload,
    });
    expect(openedReplay.statusCode).toBe(201);
    expect(openedReplay.headers["x-idempotency-replayed"]).toBe("true");
    expect(openedReplay.json().id).toBe(opened.json().id);

    const chargebackId = opened.json().id as string;

    const underReview = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargebackId}/resolve`,
      headers: withAuthAndIdempotency("chargeback-resolve-review-1"),
      payload: { status: "under_review" },
    });
    expect(underReview.statusCode).toBe(200);
    expect(underReview.json().status).toBe("under_review");

    const lost = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargebackId}/resolve`,
      headers: withAuthAndIdempotency("chargeback-resolve-lost-1"),
      payload: { status: "lost" },
    });
    expect(lost.statusCode).toBe(200);
    expect(lost.json().status).toBe("lost");

    const chargebacks = await app.inject({
      method: "GET",
      url: `/v1/chargebacks?payment_intent_id=${paymentIntentId}&status=lost`,
      headers: withAuth(),
    });
    expect(chargebacks.statusCode).toBe(200);
    expect(chargebacks.json().data.length).toBe(1);
    expect(chargebacks.json().data[0].id).toBe(chargebackId);

    const ledger = await app.inject({
      method: "GET",
      url: `/v1/ledger-entries?payment_intent_id=${paymentIntentId}&entry_type=chargeback`,
      headers: withAuth(),
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.length).toBe(1);
    expect(ledger.json().data[0].direction).toBe("debit");
    expect(ledger.json().data[0].amount).toBe(2200);

    const lostEvents = await app.inject({
      method: "GET",
      url: "/v1/payment-events?event_type=chargeback.lost",
      headers: withAuth(),
    });
    expect(lostEvents.statusCode).toBe(200);
    expect(
      lostEvents.json().data.some((event: { type: string; data: { chargeback_id?: string } }) => {
        return event.type === "chargeback.lost" && event.data.chargeback_id === chargebackId;
      }),
    ).toBe(true);
  });

  it("supports chargeback pagination with cursor", async () => {
    const paymentIntentIds: string[] = [];
    for (const suffix of ["one", "two"]) {
      const create = await app.inject({
        method: "POST",
        url: "/v1/payment-intents",
        headers: withAuthAndIdempotency(`chargeback-page-create-${suffix}`),
        payload: {
          amount: 4100,
          currency: "BRL",
          customer: { id: `cus_chargeback_page_${suffix}` },
          payment_method: { type: "card", token: "tok_test_visa" },
          capture_method: "automatic",
        },
      });
      const id = create.json().id as string;
      paymentIntentIds.push(id);
      await app.inject({
        method: "POST",
        url: `/v1/payment-intents/${id}/confirm`,
        headers: withAuthAndIdempotency(`chargeback-page-confirm-${suffix}`),
      });
      await app.inject({
        method: "POST",
        url: "/v1/chargebacks",
        headers: withAuthAndIdempotency(`chargeback-page-open-${suffix}`),
        payload: {
          payment_intent_id: id,
          amount: 600,
          reason: "other",
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/chargebacks?limit=1",
      headers: withAuth(),
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().data.length).toBe(1);
    expect(firstPage.json().pagination.has_more).toBe(true);
    expect(firstPage.json().pagination.next_cursor).toBeTypeOf("string");

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/chargebacks?limit=1&cursor=${firstPage.json().pagination.next_cursor}`,
      headers: withAuth(),
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().data.length).toBe(1);
    expect(secondPage.json().pagination.has_more).toBe(false);
    expect(secondPage.json().pagination.next_cursor).toBeNull();
    const firstCreatedId = paymentIntentIds[0];
    const secondCreatedId = paymentIntentIds[1];
    expect(firstCreatedId).toBeDefined();
    expect(secondCreatedId).toBeDefined();
    if (!firstCreatedId || !secondCreatedId) {
      throw new Error("Expected two created payment intents for chargeback pagination.");
    }

    const ids = new Set<string>([firstPage.json().data[0].payment_intent_id, secondPage.json().data[0].payment_intent_id]);
    expect(ids.has(firstCreatedId)).toBe(true);
    expect(ids.has(secondCreatedId)).toBe(true);
  });

  it("rejects invalid chargeback payloads and invalid transitions", async () => {
    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuth(),
      payload: {
        payment_intent_id: "pi_missing",
        amount: 100,
        reason: "fraud",
      },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json().error.code).toBe("missing_idempotency_key");

    const badPayload = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuthAndIdempotency("chargeback-invalid-payload"),
      payload: {
        payment_intent_id: "pi_invalid",
        amount: 100,
        reason: "invalid_reason",
      },
    });
    expect(badPayload.statusCode).toBe(422);
    expect(badPayload.json().error.code).toBe("invalid_chargeback_reason");

    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("chargeback-transition-create"),
      payload: {
        amount: 3700,
        currency: "BRL",
        customer: { id: "cus_chargeback_transition" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("chargeback-transition-confirm"),
    });

    const opened = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuthAndIdempotency("chargeback-transition-open"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 700,
        reason: "service_not_received",
      },
    });
    const chargebackId = opened.json().id as string;

    const won = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargebackId}/resolve`,
      headers: withAuthAndIdempotency("chargeback-transition-won"),
      payload: { status: "won" },
    });
    expect(won.statusCode).toBe(200);

    const invalidTerminalTransition = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargebackId}/resolve`,
      headers: withAuthAndIdempotency("chargeback-transition-lost-after-won"),
      payload: { status: "lost" },
    });
    expect(invalidTerminalTransition.statusCode).toBe(409);
    expect(invalidTerminalTransition.json().error.code).toBe("invalid_chargeback_state");

    const invalidResolveBody = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargebackId}/resolve`,
      headers: withAuthAndIdempotency("chargeback-transition-bad-status"),
      payload: { status: "open" },
    });
    expect(invalidResolveBody.statusCode).toBe(422);
    expect(invalidResolveBody.json().error.code).toBe("invalid_chargeback_status");
  });

  it("builds reconciliation summary including chargeback totals", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: withAuthAndIdempotency("reconciliation-create"),
      payload: {
        amount: 10000,
        currency: "BRL",
        customer: { id: "cus_reconciliation" },
        payment_method: { type: "card", token: "tok_test_visa" },
        capture_method: "automatic",
      },
    });
    const paymentIntentId = create.json().id as string;

    await app.inject({
      method: "POST",
      url: `/v1/payment-intents/${paymentIntentId}/confirm`,
      headers: withAuthAndIdempotency("reconciliation-confirm"),
    });

    const refund = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: withAuthAndIdempotency("reconciliation-refund"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 2500,
      },
    });
    expect(refund.statusCode).toBe(201);
    expect(refund.json().status).toBe("succeeded");

    const chargeback = await app.inject({
      method: "POST",
      url: "/v1/chargebacks",
      headers: withAuthAndIdempotency("reconciliation-chargeback"),
      payload: {
        payment_intent_id: paymentIntentId,
        amount: 1200,
        reason: "chargeback_dispute",
      },
    });
    expect(chargeback.statusCode).toBe(201);

    const chargebackLost = await app.inject({
      method: "POST",
      url: `/v1/chargebacks/${chargeback.json().id}/resolve`,
      headers: withAuthAndIdempotency("reconciliation-chargeback-lost"),
      payload: { status: "lost" },
    });
    expect(chargebackLost.statusCode).toBe(200);

    const summary = await app.inject({
      method: "GET",
      url: "/v1/reconciliation/summary?currency=brl",
      headers: withAuth(),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().currency).toBe("BRL");
    expect(summary.json().totals.captured_total).toBe(10000);
    expect(summary.json().totals.refunded_total).toBe(2500);
    expect(summary.json().totals.chargeback_total).toBe(1200);
    expect(summary.json().totals.net_settled_total).toBe(6300);
    expect(summary.json().totals.entry_count).toBeGreaterThanOrEqual(4);
  });

  it("validates chargeback and reconciliation query parameters", async () => {
    const invalidStatus = await app.inject({
      method: "GET",
      url: "/v1/chargebacks?status=invalid",
      headers: withAuth(),
    });
    expect(invalidStatus.statusCode).toBe(422);
    expect(invalidStatus.json().error.code).toBe("invalid_chargeback_status");

    const invalidChargebackRange = await app.inject({
      method: "GET",
      url: "/v1/chargebacks?created_from=2026-02-09T00:00:00.000Z&created_to=2026-02-08T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidChargebackRange.statusCode).toBe(422);
    expect(invalidChargebackRange.json().error.code).toBe("invalid_created_range");

    const invalidReconciliationRange = await app.inject({
      method: "GET",
      url: "/v1/reconciliation/summary?created_from=2026-02-09T00:00:00.000Z&created_to=2026-02-08T00:00:00.000Z",
      headers: withAuth(),
    });
    expect(invalidReconciliationRange.statusCode).toBe(422);
    expect(invalidReconciliationRange.json().error.code).toBe("invalid_created_range");
  });
});
