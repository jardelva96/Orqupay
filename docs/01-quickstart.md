# Quickstart (5 minutos)

## O que voce vai ter

- criar um `payment_intent`
- confirmar pagamento
- receber evento de status

## Pre-requisitos

- qualquer linguagem com cliente HTTP
- endpoint publico para webhook (ou tunel local)
- API local em execucao (use `reference/node-fastify`)
- API key local: `dev_pmc_key` (ou `PMC_API_KEY` customizada)

## Subir API de referencia

```bash
cd reference/node-fastify
npm install
npm run dev
```

## Fluxo minimo

1. Crie um `payment_intent`
2. Confirme o intent
3. Ouca evento `payment_intent.succeeded` no webhook

Observacao: cada operacao mutante usa uma `Idempotency-Key` propria.

## Exemplo HTTP

```bash
curl -X POST http://localhost:8080/v1/payment-intents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev_pmc_key" \
  -H "Idempotency-Key: intent-001" \
  -d '{
    "amount": 10990,
    "currency": "BRL",
    "customer": { "id": "cus_123" },
    "payment_method": {
      "type": "card",
      "token": "tok_test_visa"
    },
    "capture_method": "automatic"
  }'
```

## Resultado esperado

- status inicial: `requires_confirmation`
- apos confirmar: `processing` -> `succeeded` (ou `failed`)

## Proximo passo

Siga para `docs/02-arquitetura-hopa.md`.
