# Configuracao Avancada (Final da Jornada)

Use este guia apenas apos o fluxo basico estar funcional.

## Arquivo de referencia

Veja `examples/payment-module.example.yaml`.

## Blocos de configuracao

1. `providers`
- credenciais e endpoints por PSP
- habilitar/desabilitar por ambiente

2. `routing`
- prioridade por metodo de pagamento
- fallback automatico por erro/timeout
- roteamento por pais, moeda, MCC

3. `risk`
- regras customizadas
- limiares por score
- listas de bloqueio e allowlist

4. `resilience`
- timeout por operacao
- retries com backoff
- circuit breaker por provedor
- `PMC_PROVIDER_CB_ENABLED` ativa/desativa circuit breaker de autorizacao
- `PMC_PROVIDER_CB_FAILURE_THRESHOLD` define quantas falhas consecutivas abrem circuito
- `PMC_PROVIDER_CB_COOLDOWN_SECONDS` define cooldown antes de tentar novamente
- `PMC_PROVIDER_CB_TRANSIENT_ONLY` limita abertura de circuito a falhas transientes
- `PMC_RATE_LIMIT_ENABLED` ativa/desativa limitador por API key
- `PMC_RATE_LIMIT_WINDOW_SECONDS` define janela do rate limit
- `PMC_RATE_LIMIT_MAX_REQUESTS` define teto de requests por janela
- a referencia aplica token bucket (burst controlado + refill progressivo)

5. `webhooks`
- assinatura HMAC
- janela anti-replay
- retries de entrega
- historico de entregas por endpoint
- fila de falhas finais (dead letters) para operacao
- sem retry para falhas permanentes HTTP 4xx
- replay operacional de dead letter por endpoint administrativo dedicado
- paginacao por cursor para listagens (`limit` + `cursor`)
- controle otimista para atualizacao com `ETag` + `If-Match`
- atualizacao operacional de endpoint (`PATCH /v1/webhook-endpoints/{id}`)
- rotacao de segredo por endpoint (`POST /v1/webhook-endpoints/{id}/rotate-secret`)

6. `observability`
- logs estruturados
- metricas RED/USE
- tracing distribuido (W3C trace context)
- endpoint Prometheus em `/metrics` controlado por `PMC_METRICS_ENABLED`

7. `security`
- API keys por ambiente
- rotacao de API keys sem downtime com `PMC_API_KEYS` (CSV)
- rotacao de credenciais
- allowlist de IP para endpoints administrativos
- limite e formato da `Idempotency-Key`
  (na referencia, nunca abaixo de 128 para manter compatibilidade de contrato)
- janela de replay da idempotencia (`PMC_IDEMPOTENCY_TTL_SECONDS`, default 86400)
- header de observabilidade de replay (`X-Idempotency-Replayed`)

8. `eventing`
- definir `api_version` dos eventos (`PMC_EVENT_API_VERSION`)
- definir fonte canônica dos eventos (`PMC_EVENT_SOURCE`)
- definir versao de schema de evento (`PMC_EVENT_SCHEMA_VERSION`)
- manter versionamento consistente entre AsyncAPI e payload runtime

9. `pagination`
- `PMC_LIST_DEFAULT_LIMIT` define o limite padrao das listagens (default: `50`)
- `PMC_LIST_MAX_LIMIT` define o teto aplicado em runtime (default: `500`)
- `PMC_LIST_DEFAULT_LIMIT` deve ser menor ou igual a `PMC_LIST_MAX_LIMIT`
- `PMC_CURSOR_SECRET` assina cursores opacos e deve ser rotacionado com seguranca
- `PMC_CURSOR_SECRETS` permite rotacao sem downtime (CSV, primeiro segredo assina novos cursores)
  e todos os segredos listados validam cursores legados

## Ordem recomendada

1. resiliencia
2. webhooks
3. roteamento
4. risco
5. observabilidade
