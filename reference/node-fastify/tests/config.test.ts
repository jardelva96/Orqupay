import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/infra/app-error.js";
import { loadRuntimeConfig } from "../src/infra/config.js";

const originalEnv = { ...process.env };

function resetEnv(): void {
  process.env = { ...originalEnv };
}

afterEach(() => {
  resetEnv();
});

describe("Runtime config", () => {
  it("loads defaults", () => {
    delete process.env.HOST;
    delete process.env.PORT;
    delete process.env.PMC_API_KEY;
    delete process.env.PMC_API_KEYS;
    delete process.env.PMC_CURSOR_SECRET;
    delete process.env.PMC_CURSOR_SECRETS;
    delete process.env.PMC_IDEMPOTENCY_KEY_MAX_LENGTH;
    delete process.env.PMC_IDEMPOTENCY_TTL_SECONDS;
    delete process.env.PMC_LIST_DEFAULT_LIMIT;
    delete process.env.PMC_LIST_MAX_LIMIT;
    delete process.env.PMC_EVENT_API_VERSION;
    delete process.env.PMC_EVENT_SOURCE;
    delete process.env.PMC_EVENT_SCHEMA_VERSION;
    delete process.env.PMC_RISK_REVIEW_AMOUNT_THRESHOLD;
    delete process.env.PMC_WEBHOOK_MAX_ATTEMPTS;
    delete process.env.PMC_WEBHOOK_TIMEOUT_MS;
    delete process.env.PMC_PROVIDER_CB_ENABLED;
    delete process.env.PMC_PROVIDER_CB_FAILURE_THRESHOLD;
    delete process.env.PMC_PROVIDER_CB_COOLDOWN_SECONDS;
    delete process.env.PMC_PROVIDER_CB_TRANSIENT_ONLY;
    delete process.env.PMC_METRICS_ENABLED;
    delete process.env.PMC_RATE_LIMIT_ENABLED;
    delete process.env.PMC_RATE_LIMIT_WINDOW_SECONDS;
    delete process.env.PMC_RATE_LIMIT_MAX_REQUESTS;
    delete process.env.PMC_PAYMENT_BACKEND;
    delete process.env.PMC_IDEMPOTENCY_BACKEND;
    delete process.env.PMC_RATE_LIMIT_BACKEND;
    delete process.env.PMC_EVENT_BUS_BACKEND;
    delete process.env.PMC_POSTGRES_URL;
    delete process.env.PMC_REDIS_URL;
    delete process.env.PMC_REDIS_RATE_LIMIT_PREFIX;
    delete process.env.PMC_EVENT_STREAM_KEY;
    delete process.env.PMC_EVENT_CONSUMER_GROUP;
    delete process.env.PMC_EVENT_CONSUMER_NAME;
    delete process.env.PMC_EVENT_CONSUMER_BLOCK_MS;
    delete process.env.PMC_EVENT_CONSUMER_BATCH_SIZE;

    const config = loadRuntimeConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.apiKey).toBe("dev_pmc_key");
    expect(config.apiKeys).toEqual(["dev_pmc_key"]);
    expect(config.cursorSecret).toBe("dev_cursor_secret_change_me_2026");
    expect(config.cursorVerificationSecrets).toEqual(["dev_cursor_secret_change_me_2026"]);
    expect(config.idempotencyKeyMaxLength).toBe(128);
    expect(config.idempotencyTtlSeconds).toBe(86400);
    expect(config.listDefaultLimit).toBe(50);
    expect(config.listMaxLimit).toBe(500);
    expect(config.eventApiVersion).toBe("2026-02-08");
    expect(config.eventSource).toBe("payment-module-core");
    expect(config.eventSchemaVersion).toBe("1.0.0");
    expect(config.providerCircuitBreakerEnabled).toBe(true);
    expect(config.providerCircuitBreakerFailureThreshold).toBe(3);
    expect(config.providerCircuitBreakerCooldownSeconds).toBe(30);
    expect(config.providerCircuitBreakerTransientOnly).toBe(true);
    expect(config.metricsEnabled).toBe(true);
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.rateLimitWindowSeconds).toBe(1);
    expect(config.rateLimitMaxRequests).toBe(1000);
    expect(config.paymentBackend).toBe("memory");
    expect(config.idempotencyBackend).toBe("memory");
    expect(config.rateLimitBackend).toBe("memory");
    expect(config.eventBusBackend).toBe("memory");
    expect(config.redisRateLimitPrefix).toBe("pmc:ratelimit");
    expect(config.eventStreamKey).toBe("pmc:events");
    expect(config.eventConsumerGroup).toBe("pmc:webhook");
    expect(config.eventConsumerBlockMs).toBe(1000);
    expect(config.eventConsumerBatchSize).toBe(20);
  });

  it("rejects invalid port range", () => {
    process.env.PORT = "99999";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("rejects default API key in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PMC_API_KEY = "dev_pmc_key";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts explicit production key and event version", () => {
    process.env.NODE_ENV = "production";
    process.env.PMC_API_KEY = "prod_super_secret_key";
    process.env.PMC_CURSOR_SECRET = "prod_cursor_secret_key_123";
    process.env.PMC_EVENT_API_VERSION = "2026-02-08.1";
    process.env.PMC_EVENT_SOURCE = "pmc-prod";
    process.env.PMC_EVENT_SCHEMA_VERSION = "1.0.2";

    const config = loadRuntimeConfig();
    expect(config.apiKey).toBe("prod_super_secret_key");
    expect(config.apiKeys).toEqual(["prod_super_secret_key"]);
    expect(config.cursorSecret).toBe("prod_cursor_secret_key_123");
    expect(config.eventApiVersion).toBe("2026-02-08.1");
    expect(config.eventSource).toBe("pmc-prod");
    expect(config.eventSchemaVersion).toBe("1.0.2");
  });

  it("rejects default cursor secret in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PMC_API_KEY = "prod_super_secret_key";
    process.env.PMC_CURSOR_SECRET = "dev_cursor_secret_change_me_2026";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("supports API key rotation list", () => {
    process.env.PMC_API_KEYS = "new_key_12345678,old_key_12345678";

    const config = loadRuntimeConfig();
    expect(config.apiKey).toBe("new_key_12345678");
    expect(config.apiKeys).toEqual(["new_key_12345678", "old_key_12345678"]);
  });

  it("rejects empty API key rotation list", () => {
    process.env.PMC_API_KEYS = " , ";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("rejects default API key in production when rotation list is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.PMC_API_KEYS = "dev_pmc_key,prod_key_12345678";
    process.env.PMC_CURSOR_SECRET = "prod_cursor_secret_key_123";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("supports cursor secret rotation list", () => {
    process.env.PMC_CURSOR_SECRETS = "cursor_secret_new_123456,cursor_secret_old_123456";

    const config = loadRuntimeConfig();
    expect(config.cursorSecret).toBe("cursor_secret_new_123456");
    expect(config.cursorVerificationSecrets).toEqual([
      "cursor_secret_new_123456",
      "cursor_secret_old_123456",
    ]);
  });

  it("rejects empty cursor secret list", () => {
    process.env.PMC_CURSOR_SECRETS = " , ";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("rejects invalid idempotency key max length", () => {
    process.env.PMC_IDEMPOTENCY_KEY_MAX_LENGTH = "8";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts idempotency key max length >= 128", () => {
    process.env.PMC_IDEMPOTENCY_KEY_MAX_LENGTH = "256";
    const config = loadRuntimeConfig();
    expect(config.idempotencyKeyMaxLength).toBe(256);
  });

  it("rejects invalid idempotency ttl", () => {
    process.env.PMC_IDEMPOTENCY_TTL_SECONDS = "0";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts explicit idempotency ttl", () => {
    process.env.PMC_IDEMPOTENCY_TTL_SECONDS = "600";
    const config = loadRuntimeConfig();
    expect(config.idempotencyTtlSeconds).toBe(600);
  });

  it("rejects default list limit greater than max list limit", () => {
    process.env.PMC_LIST_DEFAULT_LIMIT = "501";
    process.env.PMC_LIST_MAX_LIMIT = "500";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts explicit list limits", () => {
    process.env.PMC_LIST_DEFAULT_LIMIT = "25";
    process.env.PMC_LIST_MAX_LIMIT = "200";

    const config = loadRuntimeConfig();
    expect(config.listDefaultLimit).toBe(25);
    expect(config.listMaxLimit).toBe(200);
  });

  it("accepts explicit provider circuit breaker config", () => {
    process.env.PMC_PROVIDER_CB_ENABLED = "false";
    process.env.PMC_PROVIDER_CB_FAILURE_THRESHOLD = "5";
    process.env.PMC_PROVIDER_CB_COOLDOWN_SECONDS = "90";
    process.env.PMC_PROVIDER_CB_TRANSIENT_ONLY = "false";

    const config = loadRuntimeConfig();
    expect(config.providerCircuitBreakerEnabled).toBe(false);
    expect(config.providerCircuitBreakerFailureThreshold).toBe(5);
    expect(config.providerCircuitBreakerCooldownSeconds).toBe(90);
    expect(config.providerCircuitBreakerTransientOnly).toBe(false);
  });

  it("rejects invalid provider circuit breaker boolean", () => {
    process.env.PMC_PROVIDER_CB_ENABLED = "nope";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts explicit metrics enabled toggle", () => {
    process.env.PMC_METRICS_ENABLED = "false";
    const config = loadRuntimeConfig();
    expect(config.metricsEnabled).toBe(false);
  });

  it("accepts explicit rate limit config", () => {
    process.env.PMC_RATE_LIMIT_ENABLED = "false";
    process.env.PMC_RATE_LIMIT_WINDOW_SECONDS = "10";
    process.env.PMC_RATE_LIMIT_MAX_REQUESTS = "200";

    const config = loadRuntimeConfig();
    expect(config.rateLimitEnabled).toBe(false);
    expect(config.rateLimitWindowSeconds).toBe(10);
    expect(config.rateLimitMaxRequests).toBe(200);
  });

  it("rejects invalid rate limit config", () => {
    process.env.PMC_RATE_LIMIT_ENABLED = "invalid";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);

    resetEnv();
    process.env.PMC_RATE_LIMIT_WINDOW_SECONDS = "0";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);

    resetEnv();
    process.env.PMC_RATE_LIMIT_MAX_REQUESTS = "0";
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("accepts distributed backend runtime config", () => {
    process.env.PMC_PAYMENT_BACKEND = "postgres";
    process.env.PMC_IDEMPOTENCY_BACKEND = "postgres";
    process.env.PMC_RATE_LIMIT_BACKEND = "redis";
    process.env.PMC_EVENT_BUS_BACKEND = "durable";
    process.env.PMC_POSTGRES_URL = "postgres://postgres:postgres@localhost:5432/pmc";
    process.env.PMC_REDIS_URL = "redis://localhost:6379";
    process.env.PMC_REDIS_RATE_LIMIT_PREFIX = "pmc:test:rl";
    process.env.PMC_EVENT_STREAM_KEY = "pmc:test:events";
    process.env.PMC_EVENT_CONSUMER_GROUP = "pmc:test:webhook";
    process.env.PMC_EVENT_CONSUMER_NAME = "pmc-test-node";
    process.env.PMC_EVENT_CONSUMER_BLOCK_MS = "250";
    process.env.PMC_EVENT_CONSUMER_BATCH_SIZE = "10";

    const config = loadRuntimeConfig();
    expect(config.paymentBackend).toBe("postgres");
    expect(config.idempotencyBackend).toBe("postgres");
    expect(config.rateLimitBackend).toBe("redis");
    expect(config.eventBusBackend).toBe("durable");
    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toContain("redis://");
    expect(config.redisRateLimitPrefix).toBe("pmc:test:rl");
    expect(config.eventStreamKey).toBe("pmc:test:events");
    expect(config.eventConsumerGroup).toBe("pmc:test:webhook");
    expect(config.eventConsumerName).toBe("pmc-test-node");
    expect(config.eventConsumerBlockMs).toBe(250);
    expect(config.eventConsumerBatchSize).toBe(10);
  });

  it("rejects postgres backend without postgres url", () => {
    process.env.PMC_PAYMENT_BACKEND = "postgres";
    delete process.env.PMC_POSTGRES_URL;
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("rejects idempotency postgres backend without postgres url", () => {
    process.env.PMC_IDEMPOTENCY_BACKEND = "postgres";
    delete process.env.PMC_POSTGRES_URL;
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });

  it("rejects redis backend without redis url", () => {
    process.env.PMC_RATE_LIMIT_BACKEND = "redis";
    delete process.env.PMC_REDIS_URL;
    expect(() => loadRuntimeConfig()).toThrowError(AppError);
  });
});
