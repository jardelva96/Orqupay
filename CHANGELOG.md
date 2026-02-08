# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows Semantic Versioning.

## [Unreleased]

### Added

- Reference implementation hardening: API key auth, risk engine, provider failover.
- Webhook subsystem with endpoint registry, signed delivery and retry.
- Webhook dead-letter queue endpoint (`GET /v1/webhook-dead-letters`) for final failures.
- Manual dead-letter replay endpoint (`POST /v1/webhook-dead-letters/{id}/replay`) with replay state tracking.
- Dead-letter detailed lookup (`GET /v1/webhook-dead-letters/{id}`) and list filters (`status`, `event_type`, `endpoint_id`).
- Dead-letter batch replay endpoint (`POST /v1/webhook-dead-letters/replay-batch`) with per-item result summary.
- Provider authorization circuit breaker with runtime config and router-level tests.
- Prometheus metrics endpoint (`GET /metrics`) with HTTP latency and replay counters.
- API key rate limiting with configurable window/limits and 429 handling.
- Rate limiter upgraded to token bucket strategy for smoother quota enforcement.
- API key rotation support via `PMC_API_KEYS` (multi-key authentication window).
- Idempotent write responses now echo `Idempotency-Key` for request/response correlation.
- Payment intent list endpoint (`GET /v1/payment-intents`) with cursor pagination.
- Payment intent list filters: `status`, `customer_id`, `payment_method_type`, `created_from`, `created_to`.
- Refund list endpoint (`GET /v1/refunds`) with cursor pagination and filters.
- Payment intent payload now includes `customer_id` and `payment_method_type` in API responses.
- Payment intent list now supports `provider` and `provider_reference` filters.
- Payment intent response now includes settlement amounts: `authorized_amount`, `captured_amount`, `refunded_amount`.
- Payment intent list now supports `currency` filter and response includes computed `amount_refundable`.
- List filters now support amount ranges with `amount_min` and `amount_max` in both payment intents and refunds.
- Payment event timeline endpoint (`GET /v1/payment-events`) with cursor pagination and filters.
- Prometheus business metrics by event/status (`pmc_payment_events_total`, `pmc_payment_intent_status_total`, `pmc_refund_status_total`).
- Idempotency replay observability with `X-Idempotency-Replayed` and configurable TTL.
- Concurrency-safe idempotency execution (single-flight per `scope + Idempotency-Key`) to prevent duplicate side effects under parallel requests.
- Distributed runtime adapters: PostgreSQL-backed idempotency store and Redis-backed multi-instance token bucket rate limiter.
- Durable event processing pipeline with outbox/inbox tables in PostgreSQL and Redis Streams broker integration.
- Database migration script and local docker-compose stack for PostgreSQL/Redis runtime.
- Continuous load + chaos SLO runner (`npm run slo:chaos`) with formal availability and latency guardrails.
- Formal DR drill runner (`npm run dr:drill`) with RTO/RPO measurement and JSON evidence output.
- Institutional trust pack with compliance control matrix, evidence register, audit calendar, and runbooks.
- Benchmark regression guardrails with optional JSON output for CI (`BENCH_FAILOVER_MAX_*`, `BENCH_OUTPUT_FILE`).
- Professional quality gates: lint, coverage, contract checks.
- CI baseline and governance templates.
