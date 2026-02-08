# ADR 0002: Durable Runtime with PostgreSQL + Redis

- Status: Accepted
- Date: 2026-02-08

## Context

The reference runtime had in-memory idempotency, event bus and rate limiting.
This is sufficient for local development but not for multi-instance production deployments.

## Decision

Adopt optional distributed runtime components:

1. PostgreSQL idempotency store (`pmc_idempotency_keys`)
1. Redis token bucket rate limiter
1. Durable event pipeline with:
1. PostgreSQL outbox (`pmc_outbox_events`)
1. PostgreSQL inbox deduplication (`pmc_inbox_events`)
1. Redis Streams broker (`pmc:events` by default)

Runtime selection is configuration-driven:

- `PMC_IDEMPOTENCY_BACKEND=memory|postgres`
- `PMC_RATE_LIMIT_BACKEND=memory|redis`
- `PMC_EVENT_BUS_BACKEND=memory|durable`

## Consequences

- Positive:
  - Multi-instance consistency for idempotency and quotas.
  - Durable event delivery baseline with replay-safe processing.
  - Lower production risk without changing public API contracts.
- Trade-offs:
  - Operational complexity (PostgreSQL + Redis).
  - New migration lifecycle and infrastructure dependencies.
  - Durable path needs additional integration tests under real infrastructure.
