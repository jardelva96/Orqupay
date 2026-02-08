import { AppError } from "./app-error.js";

function invalidConfig(name: string, expectation: string): AppError {
  return new AppError(
    500,
    "invalid_runtime_config",
    `Environment variable '${name}' ${expectation}.`,
  );
}

function parseIntegerEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw invalidConfig(name, "must be an integer");
  }
  if (parsed < min || parsed > max) {
    throw invalidConfig(name, `must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseStringEnv(name: string, defaultValue: string, minLength: number): string {
  const raw = process.env[name] ?? defaultValue;
  const value = raw.trim();
  if (value.length < minLength) {
    throw invalidConfig(name, `must contain at least ${minLength} characters`);
  }
  return value;
}

function parseStringListEnv(name: string, minItemLength: number, maxItems: number): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    throw invalidConfig(name, "must contain at least one non-empty comma-separated value");
  }
  if (items.length > maxItems) {
    throw invalidConfig(name, `must contain at most ${maxItems} values`);
  }
  for (const item of items) {
    if (item.length < minItemLength) {
      throw invalidConfig(name, `items must contain at least ${minItemLength} characters`);
    }
  }

  return [...new Set(items)];
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw invalidConfig(name, "must be a boolean (true/false/1/0)");
}

function parseOptionalStringEnv(name: string, minLength: number): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  if (value.length < minLength) {
    throw invalidConfig(name, `must contain at least ${minLength} characters`);
  }
  return value;
}

function parseEnumEnv<TValue extends string>(
  name: string,
  allowedValues: readonly TValue[],
  defaultValue: TValue,
): TValue {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim() as TValue;
  if (!allowedValues.includes(normalized)) {
    throw invalidConfig(name, `must be one of: ${allowedValues.join(", ")}`);
  }
  return normalized;
}

export interface RuntimeConfig {
  host: string;
  port: number;
  apiKey: string;
  apiKeys: string[];
  cursorSecret: string;
  cursorVerificationSecrets: string[];
  idempotencyKeyMaxLength: number;
  idempotencyTtlSeconds: number;
  listDefaultLimit: number;
  listMaxLimit: number;
  eventApiVersion: string;
  eventSource: string;
  eventSchemaVersion: string;
  riskReviewAmountThreshold: number;
  webhookMaxAttempts: number;
  webhookTimeoutMs: number;
  providerCircuitBreakerEnabled: boolean;
  providerCircuitBreakerFailureThreshold: number;
  providerCircuitBreakerCooldownSeconds: number;
  providerCircuitBreakerTransientOnly: boolean;
  metricsEnabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
  paymentBackend?: "memory" | "postgres";
  idempotencyBackend?: "memory" | "postgres";
  rateLimitBackend?: "memory" | "redis";
  eventBusBackend?: "memory" | "durable";
  postgresUrl?: string;
  redisUrl?: string;
  redisRateLimitPrefix?: string;
  eventStreamKey?: string;
  eventConsumerGroup?: string;
  eventConsumerName?: string;
  eventConsumerBlockMs?: number;
  eventConsumerBatchSize?: number;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const defaultCursorSecret = "dev_cursor_secret_change_me_2026";
  const host = parseStringEnv("HOST", "0.0.0.0", 1);
  const port = parseIntegerEnv("PORT", 8080, 1, 65535);
  const configuredApiKeys = parseStringListEnv("PMC_API_KEYS", 8, 100);
  const fallbackApiKey = parseStringEnv("PMC_API_KEY", "dev_pmc_key", 8);
  const apiKeys = configuredApiKeys ?? [fallbackApiKey];
  const apiKey = apiKeys[0] ?? fallbackApiKey;
  const configuredCursorSecrets = parseStringListEnv("PMC_CURSOR_SECRETS", 16, 10);
  const fallbackCursorSecret = parseStringEnv("PMC_CURSOR_SECRET", defaultCursorSecret, 16);
  const cursorSecret = configuredCursorSecrets?.[0] ?? fallbackCursorSecret;
  const cursorVerificationSecrets = configuredCursorSecrets ?? [fallbackCursorSecret];
  // Contract guarantees support for keys up to 128 chars; runtime policy may be more permissive.
  const idempotencyKeyMaxLength = parseIntegerEnv("PMC_IDEMPOTENCY_KEY_MAX_LENGTH", 128, 128, 1024);
  const idempotencyTtlSeconds = parseIntegerEnv("PMC_IDEMPOTENCY_TTL_SECONDS", 86400, 1, 2_592_000);
  const listDefaultLimit = parseIntegerEnv("PMC_LIST_DEFAULT_LIMIT", 50, 1, 1000);
  const listMaxLimit = parseIntegerEnv("PMC_LIST_MAX_LIMIT", 500, 1, 5000);
  const eventApiVersion = parseStringEnv("PMC_EVENT_API_VERSION", "2026-02-08", 3);
  const eventSource = parseStringEnv("PMC_EVENT_SOURCE", "payment-module-core", 3);
  const eventSchemaVersion = parseStringEnv("PMC_EVENT_SCHEMA_VERSION", "1.0.0", 3);
  const riskReviewAmountThreshold = parseIntegerEnv(
    "PMC_RISK_REVIEW_AMOUNT_THRESHOLD",
    1_000_000,
    1000,
    10_000_000_000,
  );
  const webhookMaxAttempts = parseIntegerEnv("PMC_WEBHOOK_MAX_ATTEMPTS", 3, 1, 20);
  const webhookTimeoutMs = parseIntegerEnv("PMC_WEBHOOK_TIMEOUT_MS", 5000, 100, 120000);
  const providerCircuitBreakerEnabled = parseBooleanEnv("PMC_PROVIDER_CB_ENABLED", true);
  const providerCircuitBreakerFailureThreshold = parseIntegerEnv(
    "PMC_PROVIDER_CB_FAILURE_THRESHOLD",
    3,
    1,
    20,
  );
  const providerCircuitBreakerCooldownSeconds = parseIntegerEnv(
    "PMC_PROVIDER_CB_COOLDOWN_SECONDS",
    30,
    1,
    3600,
  );
  const providerCircuitBreakerTransientOnly = parseBooleanEnv("PMC_PROVIDER_CB_TRANSIENT_ONLY", true);
  const metricsEnabled = parseBooleanEnv("PMC_METRICS_ENABLED", true);
  const rateLimitEnabled = parseBooleanEnv("PMC_RATE_LIMIT_ENABLED", true);
  const rateLimitWindowSeconds = parseIntegerEnv("PMC_RATE_LIMIT_WINDOW_SECONDS", 1, 1, 3600);
  const rateLimitMaxRequests = parseIntegerEnv("PMC_RATE_LIMIT_MAX_REQUESTS", 1000, 1, 1_000_000);
  const paymentBackend = parseEnumEnv(
    "PMC_PAYMENT_BACKEND",
    ["memory", "postgres"] as const,
    "memory",
  );
  const idempotencyBackend = parseEnumEnv(
    "PMC_IDEMPOTENCY_BACKEND",
    ["memory", "postgres"] as const,
    "memory",
  );
  const rateLimitBackend = parseEnumEnv(
    "PMC_RATE_LIMIT_BACKEND",
    ["memory", "redis"] as const,
    "memory",
  );
  const eventBusBackend = parseEnumEnv(
    "PMC_EVENT_BUS_BACKEND",
    ["memory", "durable"] as const,
    "memory",
  );
  const postgresUrl = parseOptionalStringEnv("PMC_POSTGRES_URL", 12);
  const redisUrl = parseOptionalStringEnv("PMC_REDIS_URL", 8);
  const redisRateLimitPrefix = parseStringEnv("PMC_REDIS_RATE_LIMIT_PREFIX", "pmc:ratelimit", 3);
  const eventStreamKey = parseStringEnv("PMC_EVENT_STREAM_KEY", "pmc:events", 3);
  const eventConsumerGroup = parseStringEnv("PMC_EVENT_CONSUMER_GROUP", "pmc:webhook", 3);
  const eventConsumerName = parseStringEnv(
    "PMC_EVENT_CONSUMER_NAME",
    `pmc-${process.pid}`,
    3,
  );
  const eventConsumerBlockMs = parseIntegerEnv("PMC_EVENT_CONSUMER_BLOCK_MS", 1000, 10, 60000);
  const eventConsumerBatchSize = parseIntegerEnv("PMC_EVENT_CONSUMER_BATCH_SIZE", 20, 1, 1000);

  if (process.env.NODE_ENV === "production" && apiKeys.includes("dev_pmc_key")) {
    throw invalidConfig(
      configuredApiKeys ? "PMC_API_KEYS" : "PMC_API_KEY",
      "must not include default key value in production",
    );
  }
  if (process.env.NODE_ENV === "production" && cursorSecret === defaultCursorSecret) {
    throw invalidConfig("PMC_CURSOR_SECRET", "must not use default value in production");
  }
  if (listDefaultLimit > listMaxLimit) {
    throw invalidConfig("PMC_LIST_DEFAULT_LIMIT", "must be lower or equal to PMC_LIST_MAX_LIMIT");
  }
  if (
    (paymentBackend === "postgres" || idempotencyBackend === "postgres" || eventBusBackend === "durable")
    && !postgresUrl
  ) {
    throw invalidConfig("PMC_POSTGRES_URL", "is required when postgres-backed runtime features are enabled");
  }
  if ((rateLimitBackend === "redis" || eventBusBackend === "durable") && !redisUrl) {
    throw invalidConfig("PMC_REDIS_URL", "is required when redis-backed runtime features are enabled");
  }

  return {
    host,
    port,
    apiKey,
    apiKeys,
    cursorSecret,
    cursorVerificationSecrets,
    idempotencyKeyMaxLength,
    idempotencyTtlSeconds,
    listDefaultLimit,
    listMaxLimit,
    eventApiVersion,
    eventSource,
    eventSchemaVersion,
    riskReviewAmountThreshold,
    webhookMaxAttempts,
    webhookTimeoutMs,
    providerCircuitBreakerEnabled,
    providerCircuitBreakerFailureThreshold,
    providerCircuitBreakerCooldownSeconds,
    providerCircuitBreakerTransientOnly,
    metricsEnabled,
    rateLimitEnabled,
    rateLimitWindowSeconds,
    rateLimitMaxRequests,
    paymentBackend,
    idempotencyBackend,
    rateLimitBackend,
    eventBusBackend,
    redisRateLimitPrefix,
    eventStreamKey,
    eventConsumerGroup,
    eventConsumerName,
    eventConsumerBlockMs,
    eventConsumerBatchSize,
    ...(postgresUrl ? { postgresUrl } : {}),
    ...(redisUrl ? { redisUrl } : {}),
  };
}
