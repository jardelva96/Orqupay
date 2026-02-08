# Mercado e Gap (baseline em 2026-02-08)

Este documento compara o PMC com praticas publicas de provedores relevantes e define o gap para nivel enterprise global.

## Fontes oficiais (mercado)

- Stripe idempotency: <https://docs.stripe.com/api/idempotent_requests>
- Stripe list payment intents: <https://docs.stripe.com/api/payment_intents/list>
- Stripe search payment intents (filtro por valor): <https://docs.stripe.com/api/payment_intents/search>
- Stripe list events: <https://docs.stripe.com/api/events/list>
- Stripe list payment methods (filtro por tipo): <https://docs.stripe.com/api/payment_methods/list>
- Stripe list refunds: <https://docs.stripe.com/api/refunds/list>
- Stripe webhooks retries: <https://docs.stripe.com/webhooks/process-undelivered-events>
- Stripe rate limits: <https://docs.stripe.com/rate-limits>
- Adyen API idempotency: <https://docs.adyen.com/development-resources/api-idempotency/>
- Adyen webhooks retries: <https://docs.adyen.com/development-resources/webhooks/troubleshoot/>
- PayPal idempotency: <https://developer.paypal.com/api/rest/reference/idempotency/>
- PayPal list payments (legacy v1): <https://developer.paypal.com/docs/api/payments/v1/>
- Mercado Pago list refunds by payment: <https://www.mercadopago.com/developers/en/reference/chargebacks/_payments_id_refunds/get>
- Mercado Pago idempotency header: <https://www.mercadopago.com.br/developers/en/docs/checkout-bricks/payment-brick/payment-submission/pix>

## Comparacao rapida

1. Idempotencia
- PMC: `Idempotency-Key` obrigatoria em operacoes mutantes, TTL configuravel, conflito por payload diferente.
- PMC: resposta de operacoes mutantes ecoa `Idempotency-Key` para correlacao cliente-servidor.
- PMC: requests concorrentes com a mesma chave/scope sao serializados para evitar dupla execucao.
- Mercado: Stripe, Adyen, PayPal e Mercado Pago usam idempotencia robusta nos fluxos criticos.
- Status: equivalente em conceito e com protecao de concorrencia no runtime de referencia.

1.1 Listagem e consulta
- PMC: `GET /v1/payment-intents` com `limit`, `cursor`, `amount_min`, `amount_max`, `currency`, `status`, `customer_id`, `provider`, `provider_reference`, `payment_method_type`, `created_from`, `created_to`.
- PMC: payload de `PaymentIntent` retorna `customer_id`, `payment_method_type`, `provider`, `provider_reference`, `authorized_amount`, `captured_amount`, `refunded_amount` e `amount_refundable` para facilitar reconciliacao e analytics.
- Mercado: Stripe expoe filtros por `customer`, `created` e cursores na listagem de PaymentIntents; o tipo de metodo aparece no ecossistema de PaymentMethods.
- Mercado: Stripe tambem expoe busca com comparadores numericos (ex.: `amount>1000`) em PaymentIntents Search.
- Status: alinhado no baseline de paginacao e filtros principais, com ganho pratico de operador ao filtrar direto por `payment_method_type`.

1.2 Refunds e pos-venda
- PMC: `GET /v1/refunds` com `limit`, `cursor`, `payment_intent_id`, `status`, `created_from`, `created_to`.
- PMC: listagem de refunds tambem suporta `amount_min` e `amount_max` para analise financeira.
- Mercado: Stripe expoe listagem de refunds com filtros e paginacao; Mercado Pago expoe listagem por pagamento no endpoint de refunds.
- Status: alinhado no baseline de consulta de refunds; gap principal e reconciliacao financeira automatizada cross-PSP.

2. Resiliencia de webhook
- PMC: retry com regra de transiente/permanente + DLQ + replay manual e em lote via API.
- PMC: `GET /v1/payment-events` entrega timeline de eventos com filtro por `payment_intent_id`, tipo e janela temporal.
- PMC: modo duravel opcional com outbox/inbox em PostgreSQL e broker Redis Streams.
- Mercado: Stripe e Adyen fazem retry automatico com janela longa.
- Status: PMC ganha em operabilidade explicita (DLQ/replay via API) e agora possui baseline de delivery distribuido duravel.

3. Protecao de plataforma
- PMC: rate limit por API key (`429`, `Retry-After`, `RateLimit-*`) e metrica Prometheus.
- PMC: rotacao de API key sem downtime com `PMC_API_KEYS`.
- Mercado: Stripe documenta limites e resposta `429`.
- Status: alinhado no baseline HTTP; falta rate limit distribuido por tenant em storage externo.

4. Observabilidade
- PMC: `/metrics` com RED basico + contadores de replay/idempotencia, DLQ e metricas de negocio por evento/status de pagamento.
- Mercado: players grandes entregam observabilidade madura com ferramentas internas e logs ricos.
- Status: bom baseline open source; faltam tracing distribuido completo e SLO dashboards prontos.

## Onde PMC ja e melhor

- Arquitetura agnostica de linguagem/framework com contratos abertos.
- Operacao de webhook mais transparente para times internos (DLQ + replay API).
- Menor lock-in: modulo open source, porta de entrada para multi-PSP.

## Gap para "pronto de mercado global"

1. Persistencia e infraestrutura
- trocar stores em memoria por PostgreSQL/Redis/Kafka (ou equivalente).
- baseline implementado para idempotencia PostgreSQL e rate limit Redis; falta consolidar persistencia de dominio e multi-tenant hard isolation.

2. Seguranca e compliance
- trilha para PCI DSS (SAQ, segmentacao, hardening, runbooks).
- controles LGPD/GDPR (retencao, minimizacao, DSR).
- secrets management enterprise (KMS/Vault) e rotacao automatizada.

3. Confiabilidade operacional
- outbox/inbox baseline implementado com Redis Streams + PostgreSQL; falta evoluir para broker enterprise dedicado (Kafka/RabbitMQ) conforme escala.
- chaos testing e DR drill formal ja disponiveis; falta executar em ambiente produtivo com evidencia trimestral assinada.
- SLO/SLI com burn-rate alerts ainda pendente de stack completa de observabilidade.

4. Ecossistema para adocao
- SDKs oficiais (TS, Java, Go, Python, .NET).
- Terraform/Helm e playbooks de deploy.
- suite de testes de conformidade para integradores.
