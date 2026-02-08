# Webhooks

## Fluxo

1. Registrar endpoint em `POST /v1/webhook-endpoints`
2. Receber eventos assinados
3. Validar assinatura HMAC no consumidor
4. Consultar tentativas em `GET /v1/webhook-deliveries`
5. Inspecionar falhas finais em `GET /v1/webhook-dead-letters`
6. Reprocessar dead letter via `POST /v1/webhook-dead-letters/{id}/replay`
7. Consultar dead letter individual em `GET /v1/webhook-dead-letters/{id}`
8. Reprocessar em lote via `POST /v1/webhook-dead-letters/replay-batch`

## Cabecalhos enviados

- `X-PMC-Event`
- `X-PMC-Event-Id`
- `X-PMC-Timestamp`
- `X-PMC-Signature`
- `X-PMC-Signature-Key-Id`

## Campos obrigatorios no payload

- `id`
- `api_version`
- `source`
- `event_version`
- `type`
- `occurred_at`
- `data`

## Como validar assinatura

Assinatura e calculada com `HMAC-SHA256` sobre:

```text
<timestamp>.<raw_body>
```

Usando o `secret` do endpoint cadastrado.

## Politica de entrega (referencia atual)

- tentativas maximas: `3`
- timeout por tentativa: `5000ms`
- entrega com status `failed` ou `succeeded`
- falha final gera registro em dead letter com motivo:
  - `permanent_failure`
  - `max_attempts_exhausted`
- dead letter inicia com `status=pending` e `replay_count=0`
- replay bem-sucedido marca `status=replayed` e registra `last_replayed_at`
- listagem de dead letters aceita filtros `status`, `event_type`, `endpoint_id`
