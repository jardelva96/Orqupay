# Contratos Oficiais

## HTTP API

- arquivo: `contracts/openapi/payment-module.v1.yaml`
- padrao: `OpenAPI 3.1`
- seguranca: `Bearer API Key`
- idempotencia obrigatoria em operacoes mutantes (`Idempotency-Key`)
- `Idempotency-Key`: regex `^[A-Za-z0-9._:-]+$`, maximo `128` (configuravel)
- respostas mutantes expõem `X-Idempotency-Replayed` (`true|false`)
- janela de retenção de idempotencia configuravel por `PMC_IDEMPOTENCY_TTL_SECONDS`
- endpoints principais:
  - `GET /health/live`
  - `GET /health/ready`
  - `GET /metrics`
  - `POST /v1/payment-intents`
  - `GET /v1/payment-intents`
  - `GET /v1/payment-intents/{id}`
  - `POST /v1/payment-intents/{id}/confirm`
  - `POST /v1/payment-intents/{id}/capture`
  - `POST /v1/payment-intents/{id}/cancel`
  - `GET /v1/refunds`
  - `POST /v1/refunds`
  - `GET /v1/payment-events`
  - `POST /v1/webhook-endpoints`
  - `GET /v1/webhook-endpoints/{id}`
  - `PATCH /v1/webhook-endpoints/{id}`
  - `POST /v1/webhook-endpoints/{id}/rotate-secret`
  - `GET /v1/webhook-endpoints`
  - `GET /v1/webhook-deliveries`
  - `GET /v1/webhook-dead-letters`
  - `GET /v1/webhook-dead-letters/{id}`
  - `POST /v1/webhook-dead-letters/{id}/replay`
  - `POST /v1/webhook-dead-letters/replay-batch`
- listagens de webhook suportam paginacao por cursor:
  - query params: `limit`, `cursor`
  - `cursor` e token opaco assinado (nao expoe ids internos)
  - resposta inclui `pagination.limit`, `pagination.has_more`, `pagination.next_cursor`
- operacoes de update/rotacao em endpoint suportam controle otimista por `ETag` + `If-Match`

## Eventos

- arquivo: `contracts/asyncapi/payment-events.v1.yaml`
- padrao: `AsyncAPI 3.0`
- payload inclui metadados obrigatorios:
  - `api_version`
  - `source`
  - `event_version`
- eventos principais:
  - `payment_intent.created`
  - `payment_intent.processing`
  - `payment_intent.requires_action`
  - `payment_intent.succeeded`
  - `payment_intent.failed`
  - `payment_intent.canceled`
  - `refund.succeeded`
  - `refund.failed`

## Schemas JSON

- `schemas/payment-intent.v1.json`
- `schemas/webhook-event.v1.json`

## Regras de compatibilidade

1. Campos novos devem ser opcionais
2. Campos removidos exigem nova versao major
3. Eventos nao mudam sem versionamento
4. Erros seguem envelope padrao
