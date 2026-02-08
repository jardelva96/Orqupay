import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { PaymentOrchestrator } from "./application/payment-orchestrator.js";
import { ProviderRouter } from "./application/provider-router.js";
import { WebhookDispatcher } from "./application/webhook-dispatcher.js";
import { WebhookService } from "./application/webhook-service.js";
import { PgRedisDurableEventBus } from "./adapters/durable/pg-redis-event-bus.js";
import { InMemoryEventBus } from "./adapters/inmemory/event-bus.js";
import { InMemoryIdempotencyStore } from "./adapters/inmemory/idempotency-store.js";
import { InMemoryPaymentRepository } from "./adapters/inmemory/payment-repository.js";
import { InMemoryRiskEngine } from "./adapters/inmemory/risk-engine.js";
import { InMemoryWebhookRepository } from "./adapters/inmemory/webhook-repository.js";
import { InMemoryWebhookSender } from "./adapters/inmemory/webhook-sender.js";
import { PostgresIdempotencyStore } from "./adapters/postgres/idempotency-store.js";
import { PostgresPaymentRepository } from "./adapters/postgres/payment-repository.js";
import { RedisRateLimiter } from "./adapters/redis/rate-limiter.js";
import { MockProviderGateway } from "./adapters/providers/mock-provider.js";
import type { PaymentEvent, WebhookEndpointRecord } from "./domain/types.js";
import { SystemClock } from "./infra/clock.js";
import { CursorTokenService } from "./infra/cursor-token.js";
import { AppError } from "./infra/app-error.js";
import { PmcMetricsRegistry } from "./infra/metrics.js";
import { InMemoryRateLimiter } from "./infra/rate-limiter.js";
import type { EventBusPort } from "./ports/event-bus.js";
import type { IdempotencyStorePort } from "./ports/idempotency-store.js";
import type { RateLimiterPort } from "./ports/rate-limiter.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./infra/config.js";
import {
  assertCaptureInput,
  assertCreateChargebackInput,
  assertCreatePaymentIntentInput,
  assertCreateRefundInput,
  assertResolveChargebackInput,
  assertCreateWebhookEndpointInput,
  assertReplayDeadLettersBatchInput,
  assertRotateWebhookSecretInput,
  assertUpdateWebhookEndpointInput,
  normalizeChargebackStatus,
  normalizeCurrencyCode,
  normalizeCursor,
  normalizeIsoDateTime,
  normalizeLedgerDirection,
  normalizeLedgerEntryType,
  normalizePaymentMethodType,
  normalizePaymentStatus,
  normalizePositiveInteger,
  normalizeRefundStatus,
  normalizeResourceId,
  normalizeWebhookDeadLetterStatus,
  normalizeWebhookEventType,
  normalizeIfMatch,
  normalizeLimit,
} from "./api/validators.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

function setIdempotencyReplayedHeader(
  reply: { header(name: string, value: string): unknown },
  replayed: boolean,
): void {
  reply.header("X-Idempotency-Replayed", replayed ? "true" : "false");
}

function setIdempotencyKeyEchoHeader(
  reply: { header(name: string, value: string): unknown },
  idempotencyKey: string,
): void {
  reply.header("Idempotency-Key", idempotencyKey);
}

function requireIdempotencyKey(headers: Record<string, unknown>, maxLength: number): string {
  const keyHeader = headers["idempotency-key"];
  if (typeof keyHeader !== "string" || keyHeader.trim().length === 0) {
    throw new AppError(400, "missing_idempotency_key", "Idempotency-Key header is required.");
  }
  const key = keyHeader.trim();
  if (key.length > maxLength) {
    throw new AppError(
      422,
      "invalid_idempotency_key",
      `Idempotency-Key length must be <= ${maxLength}.`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AppError(
      422,
      "invalid_idempotency_key",
      "Idempotency-Key contains invalid characters.",
    );
  }
  return key;
}

function requireBearerApiKey(headers: Record<string, unknown>, validApiKeys: ReadonlySet<string>): string {
  const authorization = headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new AppError(401, "missing_api_key", "Authorization header with Bearer API key is required.");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token || !validApiKeys.has(token)) {
    throw new AppError(401, "invalid_api_key", "Invalid API key.");
  }

  return token;
}

function setRateLimitHeaders(
  reply: { header(name: string, value: string): unknown },
  options: {
    limit: number;
    remaining: number;
    resetSeconds: number;
  },
): void {
  const limit = String(options.limit);
  const remaining = String(options.remaining);
  const reset = String(options.resetSeconds);
  reply.header("RateLimit-Limit", limit);
  reply.header("RateLimit-Remaining", remaining);
  reply.header("RateLimit-Reset", reset);
  reply.header("X-RateLimit-Limit", limit);
  reply.header("X-RateLimit-Remaining", remaining);
  reply.header("X-RateLimit-Reset", reset);
}

function rateLimitIdentityFromApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function webhookEndpointEtag(endpoint: WebhookEndpointRecord): string {
  const canonical = JSON.stringify({
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    secret: endpoint.secret,
    enabled: endpoint.enabled,
    created_at: endpoint.created_at,
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `"${digest.slice(0, 24)}"`;
}

export function buildApp(config: RuntimeConfig = loadRuntimeConfig()): FastifyInstance {
  const app = Fastify({ logger: false });
  const metrics = new PmcMetricsRegistry();
  const validApiKeys = new Set<string>(config.apiKeys.length > 0 ? config.apiKeys : [config.apiKey]);
  const closeActions: Array<() => Promise<void>> = [];

  const clock = new SystemClock();
  const postgresPool =
    config.postgresUrl
    && (
      config.paymentBackend === "postgres"
      || config.idempotencyBackend === "postgres"
      || config.eventBusBackend === "durable"
    )
      ? new Pool({ connectionString: config.postgresUrl })
      : null;
  if (postgresPool) {
    closeActions.push(async () => {
      await postgresPool.end();
    });
  }

  const redisClient =
    config.redisUrl && (config.rateLimitBackend === "redis" || config.eventBusBackend === "durable")
      ? new Redis(config.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
      })
      : null;
  if (redisClient) {
    closeActions.push(async () => {
      await redisClient.quit();
    });
  }

  const repository =
    config.paymentBackend === "postgres"
      ? (() => {
        if (!postgresPool) {
          throw new AppError(500, "invalid_runtime_config", "Postgres payment backend requested without PostgreSQL.");
        }
        return new PostgresPaymentRepository(postgresPool);
      })()
      : new InMemoryPaymentRepository();

  let rateLimiter: RateLimiterPort;
  if (config.rateLimitBackend === "redis") {
    if (!redisClient) {
      throw new AppError(500, "invalid_runtime_config", "Redis rate limiting requested without Redis client.");
    }
    rateLimiter = new RedisRateLimiter(redisClient, {
      windowSeconds: config.rateLimitWindowSeconds,
      maxRequests: config.rateLimitMaxRequests,
      keyPrefix: config.redisRateLimitPrefix ?? "pmc:ratelimit",
    });
  } else {
    rateLimiter = new InMemoryRateLimiter({
      windowSeconds: config.rateLimitWindowSeconds,
      maxRequests: config.rateLimitMaxRequests,
    });
  }

  let idempotencyStore: IdempotencyStorePort;
  if (config.idempotencyBackend === "postgres") {
    if (!postgresPool) {
      throw new AppError(500, "invalid_runtime_config", "Postgres idempotency requested without PostgreSQL.");
    }
    idempotencyStore = new PostgresIdempotencyStore(postgresPool, {
      ttlSeconds: config.idempotencyTtlSeconds,
    });
  } else {
    idempotencyStore = new InMemoryIdempotencyStore({
      ttlSeconds: config.idempotencyTtlSeconds,
      clock,
    });
  }

  let eventBus: EventBusPort;
  if (config.eventBusBackend === "durable") {
    if (!postgresPool || !redisClient) {
      throw new AppError(
        500,
        "invalid_runtime_config",
        "Durable event bus requested without PostgreSQL + Redis.",
      );
    }
    const durableEventBus = new PgRedisDurableEventBus(postgresPool, redisClient, {
      streamKey: config.eventStreamKey ?? "pmc:events",
      consumerGroup: config.eventConsumerGroup ?? "pmc:webhook",
      consumerName: config.eventConsumerName ?? `pmc-${process.pid}`,
      blockMs: config.eventConsumerBlockMs ?? 1000,
      batchSize: config.eventConsumerBatchSize ?? 20,
    });
    eventBus = durableEventBus;
    closeActions.push(async () => {
      await durableEventBus.close();
    });
  } else {
    eventBus = new InMemoryEventBus();
  }
  const webhookRepository = new InMemoryWebhookRepository();
  const webhookSender = new InMemoryWebhookSender();
  const riskEngine = new InMemoryRiskEngine({ reviewAmountThreshold: config.riskReviewAmountThreshold });
  const cursorTokens = new CursorTokenService(config.cursorSecret, config.cursorVerificationSecrets);

  const providers = [
    new MockProviderGateway({
      name: "provider_a",
      supportedMethods: ["card", "pix", "boleto"],
    }),
    new MockProviderGateway({
      name: "provider_b",
      supportedMethods: ["card", "wallet", "bank_transfer"],
    }),
  ];

  const providerRouter = new ProviderRouter(providers, {
    defaultProvider: "provider_a",
    methodPriority: {
      card: ["provider_b", "provider_a"],
      pix: ["provider_a"],
      boleto: ["provider_a"],
      wallet: ["provider_b"],
      bank_transfer: ["provider_b"],
    },
  }, {
    clock,
    circuitBreaker: {
      enabled: config.providerCircuitBreakerEnabled,
      failureThreshold: config.providerCircuitBreakerFailureThreshold,
      cooldownSeconds: config.providerCircuitBreakerCooldownSeconds,
      transientFailuresOnly: config.providerCircuitBreakerTransientOnly,
    },
  });

  const orchestrator = new PaymentOrchestrator(
    repository,
    idempotencyStore,
    eventBus,
    providerRouter,
    riskEngine,
    clock,
    config.eventApiVersion,
    config.eventSource,
    config.eventSchemaVersion,
  );
  const webhookService = new WebhookService(webhookRepository, webhookSender, clock, cursorTokens, {
    deliveryTimeoutMs: config.webhookTimeoutMs,
  });
  const webhookDispatcher = new WebhookDispatcher(webhookRepository, webhookSender, clock, {
    maxAttempts: config.webhookMaxAttempts,
    timeoutMs: config.webhookTimeoutMs,
  });

  eventBus.subscribe(async (event) => {
    metrics.recordPublishedEvent(event.type);
    await webhookDispatcher.dispatch(event);
  });

  app.get("/health/live", async (_, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  app.get("/health/ready", async (_, reply) => {
    return reply.status(200).send({ status: "ready" });
  });

  app.addHook("onRequest", async (request, reply) => {
    (request as { __pmcStartNs?: bigint }).__pmcStartNs = process.hrtime.bigint();
    if (request.url.startsWith("/health/")) {
      return;
    }
    if (config.metricsEnabled && request.url === "/metrics") {
      return;
    }
    const apiKey = requireBearerApiKey(request.headers, validApiKeys);
    reply.header("X-Request-Id", request.id);
    if (!config.rateLimitEnabled) {
      return;
    }
    const rateLimitDecision = await rateLimiter.consume(rateLimitIdentityFromApiKey(apiKey));
    setRateLimitHeaders(reply, {
      limit: rateLimitDecision.limit,
      remaining: rateLimitDecision.remaining,
      resetSeconds: rateLimitDecision.resetSeconds,
    });
    if (!rateLimitDecision.allowed) {
      if (config.metricsEnabled) {
        metrics.recordRateLimitRejection("api_key");
      }
      reply.header("Retry-After", String(rateLimitDecision.retryAfterSeconds));
      throw new AppError(429, "rate_limit_exceeded", "Rate limit exceeded. Retry later.");
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!config.metricsEnabled) {
      return;
    }
    const startNs = (request as { __pmcStartNs?: bigint }).__pmcStartNs;
    if (!startNs) {
      return;
    }
    const endNs = process.hrtime.bigint();
    const durationSeconds = Number(endNs - startNs) / 1_000_000_000;
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unmatched";
    metrics.recordHttpRequest(request.method, route, reply.statusCode, durationSeconds);
  });

  app.post("/v1/payment-intents", async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    assertCreatePaymentIntentInput(request.body);
    const result = await orchestrator.createPaymentIntent(request.body, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("create_payment_intent");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.get("/v1/payment-intents", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      amount_min?: string;
      amount_max?: string;
      currency?: string;
      status?: string;
      customer_id?: string;
      provider?: string;
      provider_reference?: string;
      payment_method_type?: string;
      created_from?: string;
      created_to?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const amountMin = normalizePositiveInteger(query.amount_min, "amount_min");
    const amountMax = normalizePositiveInteger(query.amount_max, "amount_max");
    const currency = normalizeCurrencyCode(query.currency);
    const status = normalizePaymentStatus(query.status);
    const customerId = normalizeResourceId(query.customer_id, "customer_id");
    const provider = normalizeResourceId(query.provider, "provider");
    const providerReference = normalizeResourceId(query.provider_reference, "provider_reference");
    const paymentMethodType = normalizePaymentMethodType(query.payment_method_type);
    const createdFrom = normalizeIsoDateTime(query.created_from, "created_from");
    const createdTo = normalizeIsoDateTime(query.created_to, "created_to");
    if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
      throw new AppError(422, "invalid_amount_range", "amount_min must be lower or equal to amount_max.");
    }
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new AppError(422, "invalid_created_range", "created_from must be lower or equal to created_to.");
    }
    const internalCursor = cursor ? cursorTokens.decode(cursor) : undefined;
    const page = await orchestrator.listPaymentIntents({
      limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
      ...(amountMin !== undefined ? { amountMin } : {}),
      ...(amountMax !== undefined ? { amountMax } : {}),
      ...(currency ? { currency } : {}),
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(provider ? { provider } : {}),
      ...(providerReference ? { providerReference } : {}),
      ...(paymentMethodType ? { paymentMethodType } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? cursorTokens.encode(page.nextCursor) : null,
      },
    });
  });

  app.get("/v1/payment-intents/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Payment intent id is required.");
    }
    const paymentIntent = await orchestrator.getPaymentIntentById(params.id);
    return reply.status(200).send(paymentIntent);
  });

  app.post("/v1/payment-intents/:id/confirm", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Payment intent id is required.");
    }
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    const result = await orchestrator.confirmPaymentIntent(params.id, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("confirm_payment_intent");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/v1/payment-intents/:id/capture", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Payment intent id is required.");
    }
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    assertCaptureInput(request.body);
    const result = await orchestrator.capturePaymentIntent(params.id, request.body.amount, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("capture_payment_intent");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/v1/payment-intents/:id/cancel", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Payment intent id is required.");
    }
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    const result = await orchestrator.cancelPaymentIntent(params.id, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("cancel_payment_intent");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/v1/refunds", async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    assertCreateRefundInput(request.body);
    const refund = await orchestrator.createRefund(request.body, idempotencyKey);
    setIdempotencyReplayedHeader(reply, refund.idempotencyReplayed);
    if (refund.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("create_refund");
    }
    return reply.status(refund.statusCode).send(refund.body);
  });

  app.get("/v1/refunds", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      amount_min?: string;
      amount_max?: string;
      payment_intent_id?: string;
      status?: string;
      created_from?: string;
      created_to?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const amountMin = normalizePositiveInteger(query.amount_min, "amount_min");
    const amountMax = normalizePositiveInteger(query.amount_max, "amount_max");
    const paymentIntentId = normalizeResourceId(query.payment_intent_id, "payment_intent_id");
    const status = normalizeRefundStatus(query.status);
    const createdFrom = normalizeIsoDateTime(query.created_from, "created_from");
    const createdTo = normalizeIsoDateTime(query.created_to, "created_to");
    if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
      throw new AppError(422, "invalid_amount_range", "amount_min must be lower or equal to amount_max.");
    }
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new AppError(422, "invalid_created_range", "created_from must be lower or equal to created_to.");
    }

    const internalCursor = cursor ? cursorTokens.decode(cursor) : undefined;
    const page = await orchestrator.listRefunds({
      limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
      ...(amountMin !== undefined ? { amountMin } : {}),
      ...(amountMax !== undefined ? { amountMax } : {}),
      ...(paymentIntentId ? { paymentIntentId } : {}),
      ...(status ? { status } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? cursorTokens.encode(page.nextCursor) : null,
      },
    });
  });

  app.post("/v1/chargebacks", async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    assertCreateChargebackInput(request.body);
    const result = await orchestrator.createChargeback(request.body, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("create_chargeback");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/v1/chargebacks/:id/resolve", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Chargeback id is required.");
    }
    const idempotencyKey = requireIdempotencyKey(request.headers, config.idempotencyKeyMaxLength);
    setIdempotencyKeyEchoHeader(reply, idempotencyKey);
    assertResolveChargebackInput(request.body);
    const body = request.body as { status: "under_review" | "won" | "lost" };
    const result = await orchestrator.resolveChargeback(params.id, body.status, idempotencyKey);
    setIdempotencyReplayedHeader(reply, result.idempotencyReplayed);
    if (result.idempotencyReplayed) {
      metrics.recordIdempotencyReplay("resolve_chargeback");
    }
    return reply.status(result.statusCode).send(result.body);
  });

  app.get("/v1/chargebacks", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      payment_intent_id?: string;
      status?: string;
      created_from?: string;
      created_to?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const paymentIntentId = normalizeResourceId(query.payment_intent_id, "payment_intent_id");
    const status = normalizeChargebackStatus(query.status);
    const createdFrom = normalizeIsoDateTime(query.created_from, "created_from");
    const createdTo = normalizeIsoDateTime(query.created_to, "created_to");
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new AppError(422, "invalid_created_range", "created_from must be lower or equal to created_to.");
    }

    const internalCursor = cursor ? cursorTokens.decode(cursor) : undefined;
    const page = await orchestrator.listChargebacks({
      limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
      ...(paymentIntentId ? { paymentIntentId } : {}),
      ...(status ? { status } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? cursorTokens.encode(page.nextCursor) : null,
      },
    });
  });

  app.get("/v1/ledger-entries", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      amount_min?: string;
      amount_max?: string;
      payment_intent_id?: string;
      refund_id?: string;
      entry_type?: string;
      direction?: string;
      currency?: string;
      created_from?: string;
      created_to?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const amountMin = normalizePositiveInteger(query.amount_min, "amount_min");
    const amountMax = normalizePositiveInteger(query.amount_max, "amount_max");
    const paymentIntentId = normalizeResourceId(query.payment_intent_id, "payment_intent_id");
    const refundId = normalizeResourceId(query.refund_id, "refund_id");
    const entryType = normalizeLedgerEntryType(query.entry_type);
    const direction = normalizeLedgerDirection(query.direction);
    const currency = normalizeCurrencyCode(query.currency);
    const createdFrom = normalizeIsoDateTime(query.created_from, "created_from");
    const createdTo = normalizeIsoDateTime(query.created_to, "created_to");
    if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
      throw new AppError(422, "invalid_amount_range", "amount_min must be lower or equal to amount_max.");
    }
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new AppError(422, "invalid_created_range", "created_from must be lower or equal to created_to.");
    }

    const internalCursor = cursor ? cursorTokens.decode(cursor) : undefined;
    const page = await orchestrator.listLedgerEntries({
      limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
      ...(amountMin !== undefined ? { amountMin } : {}),
      ...(amountMax !== undefined ? { amountMax } : {}),
      ...(paymentIntentId ? { paymentIntentId } : {}),
      ...(refundId ? { refundId } : {}),
      ...(entryType ? { entryType } : {}),
      ...(direction ? { direction } : {}),
      ...(currency ? { currency } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? cursorTokens.encode(page.nextCursor) : null,
      },
    });
  });

  app.get("/v1/reconciliation/summary", async (request, reply) => {
    const query = request.query as {
      currency?: string;
      created_from?: string;
      created_to?: string;
    };
    const currency = normalizeCurrencyCode(query.currency);
    const createdFrom = normalizeIsoDateTime(query.created_from, "created_from");
    const createdTo = normalizeIsoDateTime(query.created_to, "created_to");
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      throw new AppError(422, "invalid_created_range", "created_from must be lower or equal to created_to.");
    }

    const summary = await orchestrator.summarizeReconciliation({
      ...(currency ? { currency } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    });
    return reply.status(200).send(summary);
  });

  app.get("/v1/payment-events", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      payment_intent_id?: string;
      event_type?: string;
      occurred_from?: string;
      occurred_to?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const paymentIntentId = normalizeResourceId(query.payment_intent_id, "payment_intent_id");
    const eventType = normalizeWebhookEventType(query.event_type);
    const occurredFrom = normalizeIsoDateTime(query.occurred_from, "occurred_from");
    const occurredTo = normalizeIsoDateTime(query.occurred_to, "occurred_to");
    if (occurredFrom && occurredTo && Date.parse(occurredFrom) > Date.parse(occurredTo)) {
      throw new AppError(422, "invalid_occurred_range", "occurred_from must be lower or equal to occurred_to.");
    }

    const internalCursor = cursor ? cursorTokens.decode(cursor) : undefined;
    const page = await eventBus.listPublishedEvents({
      limit,
      ...(internalCursor ? { cursor: internalCursor } : {}),
      ...(paymentIntentId ? { paymentIntentId } : {}),
      ...(eventType ? { eventType } : {}),
      ...(occurredFrom ? { occurredFrom } : {}),
      ...(occurredTo ? { occurredTo } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ? cursorTokens.encode(page.nextCursor) : null,
      },
    });
  });

  app.post("/v1/webhook-endpoints", async (request, reply) => {
    assertCreateWebhookEndpointInput(request.body);
    const endpoint = await webhookService.createEndpoint(request.body);
    reply.header("ETag", webhookEndpointEtag(endpoint));
    return reply.status(201).send(endpoint);
  });

  app.get("/v1/webhook-endpoints/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Webhook endpoint id is required.");
    }
    const endpoint = await webhookService.getEndpointById(params.id);
    reply.header("ETag", webhookEndpointEtag(endpoint));
    return reply.status(200).send(endpoint);
  });

  app.patch("/v1/webhook-endpoints/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Webhook endpoint id is required.");
    }
    const ifMatch = normalizeIfMatch(request.headers["if-match"]);
    const currentEndpoint = await webhookService.getEndpointById(params.id);
    const currentEtag = webhookEndpointEtag(currentEndpoint);
    if (ifMatch && ifMatch !== "*" && ifMatch !== currentEtag) {
      throw new AppError(412, "precondition_failed", "If-Match precondition failed.");
    }
    assertUpdateWebhookEndpointInput(request.body);
    const body = request.body as {
      url?: string;
      events?: PaymentEvent["type"][];
      enabled?: boolean;
    };
    const endpoint = await webhookService.updateEndpoint(params.id, body);
    reply.header("ETag", webhookEndpointEtag(endpoint));
    return reply.status(200).send(endpoint);
  });

  app.post("/v1/webhook-endpoints/:id/rotate-secret", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Webhook endpoint id is required.");
    }
    const ifMatch = normalizeIfMatch(request.headers["if-match"]);
    const currentEndpoint = await webhookService.getEndpointById(params.id);
    const currentEtag = webhookEndpointEtag(currentEndpoint);
    if (ifMatch && ifMatch !== "*" && ifMatch !== currentEtag) {
      throw new AppError(412, "precondition_failed", "If-Match precondition failed.");
    }
    assertRotateWebhookSecretInput(request.body);
    const body = (request.body ?? {}) as { secret?: string };
    const endpoint = await webhookService.rotateEndpointSecret(params.id, body.secret);
    reply.header("ETag", webhookEndpointEtag(endpoint));
    return reply.status(200).send(endpoint);
  });

  app.get("/v1/webhook-endpoints", async (request, reply) => {
    const query = request.query as { limit?: string; cursor?: string };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const page = await webhookService.listEndpoints({ limit, ...(cursor ? { cursor } : {}) });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ?? null,
      },
    });
  });

  app.get("/v1/webhook-deliveries", async (request, reply) => {
    const query = request.query as { limit?: string; cursor?: string };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const page = await webhookService.listDeliveries({ limit, ...(cursor ? { cursor } : {}) });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ?? null,
      },
    });
  });

  app.get("/v1/webhook-dead-letters", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
      status?: string;
      event_type?: string;
      endpoint_id?: string;
    };
    const limit = normalizeLimit(query.limit, config.listDefaultLimit, config.listMaxLimit);
    const cursor = normalizeCursor(query.cursor);
    const status = normalizeWebhookDeadLetterStatus(query.status);
    const eventType = normalizeWebhookEventType(query.event_type);
    const endpointId = normalizeResourceId(query.endpoint_id, "endpoint_id");
    const page = await webhookService.listDeadLetters({
      limit,
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
      ...(eventType ? { eventType } : {}),
      ...(endpointId ? { endpointId } : {}),
    });
    return reply.status(200).send({
      data: page.data,
      pagination: {
        limit,
        has_more: page.hasMore,
        next_cursor: page.nextCursor ?? null,
      },
    });
  });

  app.get("/v1/webhook-dead-letters/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Webhook dead letter id is required.");
    }
    const deadLetter = await webhookService.getDeadLetterById(params.id);
    return reply.status(200).send(deadLetter);
  });

  app.post("/v1/webhook-dead-letters/:id/replay", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      throw new AppError(400, "invalid_path_parameter", "Webhook dead letter id is required.");
    }
    const deadLetter = await webhookService.replayDeadLetter(params.id);
    metrics.recordDeadLetterReplayOutcome(deadLetter.status === "replayed" ? "replayed" : "failed");
    return reply.status(200).send(deadLetter);
  });

  app.post("/v1/webhook-dead-letters/replay-batch", async (request, reply) => {
    assertReplayDeadLettersBatchInput(request.body);
    const body = (request.body ?? {}) as {
      limit?: number;
      status?: "pending" | "replayed";
      event_type?: PaymentEvent["type"];
      endpoint_id?: string;
    };
    const limit = body.limit ?? config.listDefaultLimit;
    if (limit > config.listMaxLimit) {
      throw new AppError(422, "invalid_replay_batch", `limit must be less than or equal to ${config.listMaxLimit}.`);
    }

    const result = await webhookService.replayDeadLettersBatch({
      limit,
      ...(body.status ? { status: body.status } : {}),
      ...(body.event_type ? { eventType: body.event_type } : {}),
      ...(body.endpoint_id ? { endpointId: body.endpoint_id } : {}),
    });
    for (const item of result.data) {
      metrics.recordDeadLetterReplayOutcome(item.outcome);
    }
    return reply.status(200).send(result);
  });

  if (config.metricsEnabled) {
    app.get("/metrics", async (_request, reply) => {
      const payload = metrics.renderPrometheus();
      return reply
        .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        .status(200)
        .send(payload);
    });
  }

  app.setNotFoundHandler(async (_, reply) => {
    return reply.status(404).send({
      error: {
        code: "resource_not_found",
        message: "Route not found.",
      },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: request.id,
        },
      });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({
      error: {
        code: "internal_server_error",
        message: "Unexpected error.",
        request_id: request.id,
      },
    });
  });

  app.addHook("onClose", async () => {
    for (const closeAction of [...closeActions].reverse()) {
      await closeAction();
    }
  });

  return app;
}
