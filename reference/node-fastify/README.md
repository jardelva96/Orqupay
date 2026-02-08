# Reference Implementation: Node + Fastify

Implementacao oficial de referencia do `Payment Module Core` com arquitetura `Ports & Adapters`.

## Stack

- Node 20+
- TypeScript
- Fastify
- Vitest

## Executar localmente

```bash
cd reference/node-fastify
npm install
npm run dev
```

API em `http://localhost:8080`.
Métricas Prometheus em `http://localhost:8080/metrics` quando `PMC_METRICS_ENABLED=true`.

Inclui RED HTTP + metricas de negocio por evento/status (`pmc_payment_events_total`, `pmc_payment_intent_status_total`, `pmc_refund_status_total`).

## Executar com Docker (producao)

Build da imagem:

```bash
cd reference/node-fastify
docker build -t pmc-reference-node-fastify:local .
```

Run da API:

```bash
docker run --rm -p 8080:8080 \
  -e PMC_API_KEY=pmc_local_key_123456 \
  -e PMC_CURSOR_SECRET=pmc_local_cursor_secret_123456 \
  pmc-reference-node-fastify:local
```

## Variaveis de ambiente

- `PMC_API_KEY` (default: `dev_pmc_key`)
- `PMC_API_KEYS` (opcional, CSV para rotacao; qualquer chave listada e aceita)
- `PMC_CURSOR_SECRET` (default: `dev_cursor_secret_change_me_2026`)
- `PMC_CURSOR_SECRETS` (opcional, CSV para rotacao; primeiro valor assina novos tokens)
- `PMC_IDEMPOTENCY_KEY_MAX_LENGTH` (default: `128`)
- `PMC_IDEMPOTENCY_TTL_SECONDS` (default: `86400`)
- `PMC_LIST_DEFAULT_LIMIT` (default: `50`)
- `PMC_LIST_MAX_LIMIT` (default: `500`)
- `PMC_EVENT_API_VERSION` (default: `2026-02-08`)
- `PMC_EVENT_SOURCE` (default: `payment-module-core`)
- `PMC_EVENT_SCHEMA_VERSION` (default: `1.0.0`)
- `PMC_RISK_REVIEW_AMOUNT_THRESHOLD` (default: `1000000`)
- `PMC_WEBHOOK_MAX_ATTEMPTS` (default: `3`)
- `PMC_WEBHOOK_TIMEOUT_MS` (default: `5000`)
- `PMC_PROVIDER_CB_ENABLED` (default: `true`)
- `PMC_PROVIDER_CB_FAILURE_THRESHOLD` (default: `3`)
- `PMC_PROVIDER_CB_COOLDOWN_SECONDS` (default: `30`)
- `PMC_PROVIDER_CB_TRANSIENT_ONLY` (default: `true`)
- `PMC_METRICS_ENABLED` (default: `true`)
- `PMC_RATE_LIMIT_ENABLED` (default: `true`)
- `PMC_RATE_LIMIT_WINDOW_SECONDS` (default: `1`)
- `PMC_RATE_LIMIT_MAX_REQUESTS` (default: `1000`)
- `PMC_PAYMENT_BACKEND` (`memory|postgres`, default: `memory`)
- `PMC_IDEMPOTENCY_BACKEND` (`memory|postgres`, default: `memory`)
- `PMC_RATE_LIMIT_BACKEND` (`memory|redis`, default: `memory`)
- `PMC_EVENT_BUS_BACKEND` (`memory|durable`, default: `memory`)
- `PMC_POSTGRES_URL` (obrigatoria quando usar `postgres`/`durable`)
- `PMC_REDIS_URL` (obrigatoria quando usar `redis`/`durable`)
- `PMC_REDIS_RATE_LIMIT_PREFIX` (default: `pmc:ratelimit`)
- `PMC_EVENT_STREAM_KEY` (default: `pmc:events`)
- `PMC_EVENT_CONSUMER_GROUP` (default: `pmc:webhook`)
- `PMC_EVENT_CONSUMER_NAME` (default: `pmc-<pid>`)
- `PMC_EVENT_CONSUMER_BLOCK_MS` (default: `1000`)
- `PMC_EVENT_CONSUMER_BATCH_SIZE` (default: `20`)
- `HOST` (default: `0.0.0.0`)
- `PORT` (default: `8080`)

## Autenticacao

Todos os endpoints exigem:

```text
Authorization: Bearer <API_KEY>
```

Padrao local: `PMC_API_KEY=dev_pmc_key`.
Em `NODE_ENV=production`, a API falha ao iniciar se `PMC_API_KEY` estiver no valor default.
Em `NODE_ENV=production`, a API falha ao iniciar se `PMC_API_KEYS` contiver `dev_pmc_key`.
Em `NODE_ENV=production`, a API tambem falha ao iniciar se `PMC_CURSOR_SECRET` estiver no valor default.
Quando `PMC_API_KEYS` estiver definido, todas as chaves listadas sao aceitas para autenticacao
e a primeira pode ser tratada como chave ativa para rollout.
Quando `PMC_CURSOR_SECRETS` estiver definido, o primeiro segredo da lista vira o segredo ativo.
Todos os segredos da lista sao aceitos para validacao de cursores antigos.

Rate limit por API key:

- `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` em todas as respostas autenticadas
- `429 rate_limit_exceeded` quando excede a janela configurada
- `Retry-After` em respostas `429`
- estrategia de rate limit da referencia: token bucket (suporta burst curto com reposicao gradual)

Operacoes mutantes exigem `Idempotency-Key`:

- `POST /v1/payment-intents`
- `POST /v1/payment-intents/{id}/confirm`
- `POST /v1/payment-intents/{id}/capture`
- `POST /v1/payment-intents/{id}/cancel`
- `POST /v1/refunds`

Operacoes de consulta de pagamentos:

- `GET /v1/payment-intents`
- `GET /v1/payment-intents/{id}`
- `GET /v1/refunds`
- `GET /v1/ledger-entries`
- `GET /v1/payment-events`
- payload de `payment-intent` inclui `authorized_amount`, `captured_amount`, `refunded_amount`, `amount_refundable`, `provider` e `provider_reference`

Listagem de pagamentos tambem suporta cursor opaco:

- query params: `limit`, `cursor`
- resposta inclui `pagination.limit`, `pagination.has_more`, `pagination.next_cursor`
- filtros opcionais: `amount_min`, `amount_max`, `currency`, `status`, `customer_id`, `provider`, `provider_reference`, `payment_method_type`, `created_from`, `created_to`

Listagem de refunds tambem suporta cursor opaco:

- query params: `limit`, `cursor`
- filtros opcionais: `amount_min`, `amount_max`, `payment_intent_id`, `status`, `created_from`, `created_to`

Listagem de eventos de pagamento suporta cursor opaco:

- query params: `limit`, `cursor`
- filtros opcionais: `payment_intent_id`, `event_type`, `occurred_from`, `occurred_to`

Listagem de ledger entries suporta cursor opaco:

- query params: `limit`, `cursor`
- filtros opcionais: `amount_min`, `amount_max`, `payment_intent_id`, `refund_id`, `entry_type`, `direction`, `currency`, `created_from`, `created_to`

Formato aceito para `Idempotency-Key`:

- caracteres: `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`
- tamanho maximo configuravel por `PMC_IDEMPOTENCY_KEY_MAX_LENGTH`
- janela de replay configuravel por `PMC_IDEMPOTENCY_TTL_SECONDS` (default 24h)
- para manter contrato publico, o runtime nao permite valor menor que `128`
- concorrencia com mesma chave/scope e serializada (single-flight) para evitar efeito duplicado

Respostas idempotentes mutantes retornam:

- `Idempotency-Key: <valor_enviado>` para rastreabilidade no cliente
- `X-Idempotency-Replayed: false` para primeira execucao
- `X-Idempotency-Replayed: true` quando a resposta foi reaproveitada do storage de idempotencia

## Runtime distribuido (PostgreSQL + Redis)

Suba a infra local:

```bash
docker compose -f docker-compose.durable.yml up -d
```

Se sua maquina ja usa PostgreSQL local na porta `5432`, ajuste o mapeamento em
`docker-compose.durable.yml` e atualize `PMC_POSTGRES_URL` conforme a porta publicada.
O compose usa por default `55432` para PostgreSQL e `56379` para Redis.
Voce tambem pode sobrescrever sem editar arquivo:

```bash
PMC_DOCKER_POSTGRES_PORT=55432 PMC_DOCKER_REDIS_PORT=56379 docker compose -f docker-compose.durable.yml up -d
```

Aplique migracoes:

```bash
PMC_POSTGRES_URL=postgres://postgres:postgres@localhost:55432/pmc npm run db:migrate
```

Execute o modulo em modo distribuido:

```bash
PMC_PAYMENT_BACKEND=postgres \
PMC_IDEMPOTENCY_BACKEND=postgres \
PMC_RATE_LIMIT_BACKEND=redis \
PMC_EVENT_BUS_BACKEND=durable \
PMC_POSTGRES_URL=postgres://postgres:postgres@localhost:55432/pmc \
PMC_REDIS_URL=redis://localhost:56379 \
npm run dev
```

No PowerShell (Windows):

```powershell
$env:PMC_PAYMENT_BACKEND = "postgres"
$env:PMC_IDEMPOTENCY_BACKEND = "postgres"
$env:PMC_RATE_LIMIT_BACKEND = "redis"
$env:PMC_EVENT_BUS_BACKEND = "durable"
$env:PMC_POSTGRES_URL = "postgres://postgres:postgres@localhost:55432/pmc"
$env:PMC_REDIS_URL = "redis://localhost:56379"
npm run dev
```

Nesse modo:

- payment intents/refunds/ledger ficam persistidos em PostgreSQL (compartilhados entre instancias)
- idempotencia fica persistida em PostgreSQL (compartilhada entre instancias)
- rate limit usa token bucket distribuido em Redis
- eventos usam outbox/inbox em PostgreSQL + stream duravel em Redis

## Webhooks

Endpoints suportados:

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

Listagens de webhooks suportam paginacao por cursor:

- query params: `limit`, `cursor`
- resposta inclui `pagination.limit`, `pagination.has_more`, `pagination.next_cursor`
- `limit` e truncado em runtime por `PMC_LIST_MAX_LIMIT`
- `cursor` e token opaco assinado (nao um id interno em texto claro)
- endpoints individuais retornam `ETag`
- `PATCH` e `rotate-secret` aceitam `If-Match` para controle otimista (retorna `412` em conflito)
- DLQ suporta filtros em listagem: `status`, `event_type`, `endpoint_id`

Cada entrega de webhook usa assinatura HMAC SHA-256 com cabecalhos:

- `X-PMC-Signature`
- `X-PMC-Signature-Key-Id`
- `X-PMC-Timestamp`
- `X-PMC-Event`
- `X-PMC-Event-Id`

Politica de retry de webhook:

- falhas transientes: retenta ate `PMC_WEBHOOK_MAX_ATTEMPTS`
- falhas permanentes HTTP `4xx`: nao retenta
  (exceto `408`, `425`, `429`, que sao tratadas como transientes)
- falhas finais sao registradas em `GET /v1/webhook-dead-letters`
- dead letters possuem `status` (`pending|replayed`) e `replay_count`
- replay manual pode ser acionado em `POST /v1/webhook-dead-letters/{id}/replay`
- replay em lote pode ser acionado em `POST /v1/webhook-dead-letters/replay-batch`

Resiliencia de provedor (circuit breaker):

- abre circuito apos `PMC_PROVIDER_CB_FAILURE_THRESHOLD` falhas consecutivas
- circuito fica aberto por `PMC_PROVIDER_CB_COOLDOWN_SECONDS`
- com `PMC_PROVIDER_CB_TRANSIENT_ONLY=true`, somente falhas transientes contam para abrir circuito

## Testes e qualidade

```bash
npm test
npm run quality
npm run benchmark:compare
npm run dr:drill
```

`quality` executa:

1. typecheck
2. testes automatizados
3. validacao de contratos (`OpenAPI`, `AsyncAPI`, `JSON Schema`)
4. consistencia de catalogo de eventos (`types`, `AsyncAPI`, `OpenAPI`, `schema`)

`benchmark:compare` compara dois cenarios:

1. autorizacao direta
2. autorizacao com failover

Variaveis opcionais do benchmark:

- `BENCH_ITERATIONS` (default: `200`)
- `BENCH_FAILOVER_MAX_AVG_DELTA_MS` (default: `5`)
- `BENCH_FAILOVER_MAX_P95_DELTA_MS` (default: `10`)
- `BENCH_OUTPUT_FILE` (opcional, grava relatorio JSON)

Teste continuo de carga + caos com SLO formal:

```bash
npm run slo:chaos
```

Variaveis opcionais:

- `SLO_TEST_DURATION_SECONDS` (default: `20`)
- `SLO_TEST_CONCURRENCY` (default: `20`)
- `SLO_MIN_AVAILABILITY_PCT` (default: `99.5`)
- `SLO_MAX_P95_MS` (default: `80`)
- `SLO_MAX_P99_MS` (default: `140`)
- `SLO_CHAOS_MODE` (`true|false`, default: `true`)
- `CHAOS_PROVIDER_UNAVAILABLE_RATIO` (default: `0`, opcional para injetar indisponibilidade real de provedor)
- `SLO_OUTPUT_FILE` (opcional, grava relatorio JSON)

DR drill formal com RTO/RPO:

```bash
npm run dr:drill
```

Variaveis opcionais:

- `DR_REQUIRE_DURABLE` (`true|false`, default: `true`)
- `DR_SAMPLE_SIZE` (default: `5`)
- `DR_SIMULATED_OUTAGE_SECONDS` (default: `2`)
- `DR_RTO_TARGET_SECONDS` (default: `300`)
- `DR_RPO_TARGET_SECONDS` (default: `60`)
- `DR_OUTPUT_FILE` (opcional, grava relatorio JSON)
