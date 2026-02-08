
<div align="center">



# 🐋 Orqupay

**Open-source payment orchestration module — API-first, contract-driven, framework-agnostic.**

[![CI](https://github.com/jardelva96/Orqupay/actions/workflows/ci.yml/badge.svg)](https://github.com/jardelva96/Orqupay/actions/workflows/ci.yml)
[![Security](https://github.com/jardelva96/Orqupay/actions/workflows/security.yml/badge.svg)](https://github.com/jardelva96/Orqupay/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1.0-6BA539.svg)](contracts/openapi/payment-module.v1.yaml)
[![AsyncAPI](https://img.shields.io/badge/AsyncAPI-3.0.0-A734C2.svg)](contracts/asyncapi/payment-events.v1.yaml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<br/>


<br/>

*Pagamentos orquestrados com a inteligencia da orca.*

[Quickstart](#-quickstart) •
[Arquitetura](#-arquitetura-hopa) •
[Contratos](#-contratos) •
[Roadmap](#-roadmap) •
[Contribuir](#-contribuindo)

</div>

---

## O que e o Orqupay?

Orqupay e um modulo de pagamentos **open source** que entrega um padrao de mercado com:

- **Contratos estaveis** — OpenAPI 3.1, AsyncAPI 3.0, JSON Schema 2020-12
- **Arquitetura desacoplada** — Ports & Adapters (hexagonal)
- **Resiliencia por padrao** — circuit breaker, retry, idempotencia, outbox pattern
- **Observabilidade nativa** — Prometheus metrics, event timeline, business KPIs
- **Zero vendor lock-in** — agnostico de linguagem, framework e banco de dados

---

## 🏗 Arquitetura HOPA

**HOPA** = **H**ybrid **O**rchestrated **P**ayment **A**rchitecture

```
                    ┌──────────────────────────────────────────┐
                    │              API Layer                    │
                    │   validation · idempotency · rate limit   │
                    └──────────────────┬───────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────┐
                    │          Orchestrator Layer               │
                    │   state machine · policies · routing      │
                    └──────────────────┬───────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────┐
                    │            Domain Layer                   │
                    │   PaymentIntent · Refund · Chargeback     │
                    └──────────────────┬───────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────┐
                    │            Ports Layer                    │
                    │   interfaces estaveis para cada porta     │
                    └────────┬─────────┬──────────┬────────────┘
                             │         │          │
                    ┌────────▼──┐ ┌────▼────┐ ┌───▼──────────┐
                    │ In-Memory │ │PostgreSQL│ │ Redis / PSPs │
                    │ (dev/test)│ │  (prod)  │ │  (adapters)  │
                    └───────────┘ └─────────┘ └──────────────┘
```

| Principio | Descricao |
|-----------|-----------|
| **Hybrid** | Sync (REST API) + Async (eventos/webhooks) |
| **Orchestrated** | Orquestrador central com state machine, roteamento e failover |
| **Payment** | Dominio modelado por estados, idempotencia e conciliacao |
| **Architecture** | Agnostica de stack — implemente em qualquer linguagem |

> Detalhes completos em [`docs/02-arquitetura-hopa.md`](docs/02-arquitetura-hopa.md)

---

## ⚡ Quickstart

```bash
# Clone o repositorio
git clone https://github.com/jardelva96/Orqupay.git
cd Orqupay/reference/node-fastify

# Instale e rode
npm install
npm run dev
```

```bash
# Crie um pagamento
curl -X POST http://localhost:8080/v1/payment-intents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev_orqupay_key" \
  -H "Idempotency-Key: test-001" \
  -d '{"amount": 5000, "currency": "BRL", "payment_method_type": "pix"}'

# Confirme o pagamento
curl -X POST http://localhost:8080/v1/payment-intents/{id}/confirm \
  -H "Authorization: Bearer dev_orqupay_key" \
  -H "Idempotency-Key: confirm-001"
```

> Guia completo em [`docs/01-quickstart.md`](docs/01-quickstart.md)

---

## 📦 Estrutura do Projeto

```
orqupay/
├── contracts/
│   ├── openapi/          # Contrato REST API (OpenAPI 3.1)
│   └── asyncapi/         # Contrato de eventos (AsyncAPI 3.0)
├── schemas/              # JSON Schemas reutilizaveis
├── docs/                 # 13 guias sequenciais
├── reference/
│   └── node-fastify/     # Implementacao de referencia executavel
├── adr/                  # Architecture Decision Records
├── ops/
│   ├── compliance/       # PCI DSS, SOC 2, ISO 27001 matrix
│   ├── dr/               # Disaster Recovery policy + drills
│   └── runbooks/         # Incident response procedures
└── examples/             # Configuracoes modelo
```

---

## 📋 Contratos

| Tipo | Arquivo | Spec |
|------|---------|------|
| REST API | [`contracts/openapi/payment-module.v1.yaml`](contracts/openapi/payment-module.v1.yaml) | OpenAPI 3.1.0 |
| Eventos | [`contracts/asyncapi/payment-events.v1.yaml`](contracts/asyncapi/payment-events.v1.yaml) | AsyncAPI 3.0.0 |
| PaymentIntent | [`schemas/payment-intent.v1.json`](schemas/payment-intent.v1.json) | JSON Schema 2020-12 |
| WebhookEvent | [`schemas/webhook-event.v1.json`](schemas/webhook-event.v1.json) | JSON Schema 2020-12 |

### Endpoints Principais

| Metodo | Endpoint | Descricao |
|--------|----------|-----------|
| `POST` | `/v1/payment-intents` | Criar intencao de pagamento |
| `POST` | `/v1/payment-intents/{id}/confirm` | Confirmar pagamento |
| `POST` | `/v1/payment-intents/{id}/capture` | Capturar pagamento |
| `POST` | `/v1/payment-intents/{id}/cancel` | Cancelar pagamento |
| `POST` | `/v1/refunds` | Solicitar reembolso |
| `POST` | `/v1/chargebacks` | Registrar chargeback |
| `GET`  | `/v1/payment-events` | Timeline de eventos |
| `GET`  | `/v1/webhook-endpoints` | Gerenciar webhooks |
| `GET`  | `/metrics` | Metricas Prometheus |
| `GET`  | `/health/live` | Health check |

---

## 🎯 Features

### Core
- **State Machine** — 6 estados canonicos com transicoes validadas
- **Idempotencia** — `Idempotency-Key` com TTL configuravel e replay detection
- **Rate Limiting** — Token bucket distribuido (in-memory ou Redis)
- **Concurrency Safety** — Single-flight por escopo para evitar duplicatas

### Pagamentos
- **Payment Intents** — Criacao, confirmacao, captura, cancelamento
- **Refunds** — Reembolso total/parcial com rastreamento
- **Chargebacks** — Abertura, resolucao (won/lost)
- **Ledger & Reconciliacao** — Entries e summary por moeda

### Resiliencia
- **Circuit Breaker** — Failover automatico entre providers
- **Provider Router** — Roteamento por custo, latencia e taxa de aprovacao
- **Outbox Pattern** — Consistencia eventos + dados na mesma transacao
- **DR Drills** — Medicao automatica de RTO/RPO com evidencia

### Webhooks
- **Registry** — CRUD de endpoints com ETag
- **Signed Delivery** — HMAC SHA-256
- **Retry + Dead Letter** — 3 tentativas + DLQ com replay manual/batch
- **Secret Rotation** — Rotacao sem downtime

### Observabilidade
- **Prometheus Metrics** — Latencia HTTP, contadores de negocio
- **Event Timeline** — Historico completo de eventos por pagamento
- **Business KPIs** — `payment_intent_status_total`, `refund_status_total`

### Enterprise & Compliance
- **PCI DSS** — Control matrix mapeado
- **SOC 2** — Evidence register
- **ISO 27001** — Audit calendar
- **Runbooks** — Incident response, DR, key compromise

---

## 🛠 Tech Stack (Referencia)

| Componente | Tecnologia |
|-----------|-----------|
| Runtime | Node.js >= 20 |
| Framework | Fastify 5 |
| Linguagem | TypeScript 5.9 |
| Banco (prod) | PostgreSQL |
| Cache/Mensageria | Redis + Streams |
| Testes | Vitest |
| Lint | ESLint 9 |
| Contratos | OpenAPI 3.1 + AsyncAPI 3.0 |
| CI/CD | GitHub Actions |
| Container | Docker multi-arch (amd64/arm64) |
| Metricas | Prometheus |

---

## 🔧 Quality Gates

```bash
cd reference/node-fastify

# Roda todos os gates de qualidade
npm run quality

# Gates individuais
npm run lint              # ESLint
npm run typecheck         # TypeScript strict
npm run test:coverage     # Vitest + coverage
npm run contracts:check   # Validacao OpenAPI/AsyncAPI
npm run events:check      # Catalogo de eventos

# Performance & Resiliencia
npm run benchmark:compare # Benchmark com regressao
npm run slo:chaos         # Load + chaos testing
npm run dr:drill          # DR com medicao RTO/RPO
```

---

## 🗺 Roadmap

| Fase | Status | Escopo |
|------|--------|--------|
| **Phase 1 — Foundation** | ✅ Atual | Contratos, HOPA, referencia Node, auth, risk engine, webhooks, quality gates |
| **Phase 2 — Production** | 🔜 Proximo | PostgreSQL persistencia, Kafka/RabbitMQ, OpenTelemetry, trust program completo |
| **Phase 3 — Scale** | 📋 Planejado | SDKs oficiais (TS, Python, Go, Java, .NET), providers reais, dashboard admin |

> Detalhes em [`docs/08-roadmap.md`](docs/08-roadmap.md)

---

## 📚 Jornada do Desenvolvedor

| # | Guia | Tempo |
|---|------|-------|
| 1 | [Quickstart](docs/01-quickstart.md) | 5 min |
| 2 | [Arquitetura HOPA](docs/02-arquitetura-hopa.md) | 15 min |
| 3 | [Design Patterns](docs/03-design-patterns.md) | 20 min |
| 4 | [Contratos](docs/04-contratos.md) | 10 min |
| 5 | [Configuracao Avancada](docs/05-configuracao-avancada.md) | 15 min |
| 6 | [Go-Live Checklist](docs/06-go-live-checklist.md) | 10 min |
| 7 | [Guia Multi-Stack](docs/07-guia-multi-stack.md) | 15 min |
| 8 | [Roadmap](docs/08-roadmap.md) | 5 min |
| 9 | [Webhooks](docs/09-webhooks.md) | 15 min |
| 10 | [Engineering Standards](docs/10-engineering-standards.md) | 10 min |
| 11 | [Mercado e Gap Analysis](docs/11-mercado-e-gap.md) | 10 min |
| 12 | [Confianca Institucional](docs/12-confianca-institucional.md) | 10 min |
| 13 | [Runbooks e DR](docs/13-runbooks-e-dr.md) | 10 min |

---

## 🤝 Contribuindo

Contribuicoes sao bem-vindas! Veja [`CONTRIBUTING.md`](CONTRIBUTING.md) para guidelines.

```bash
# Fork → Clone → Branch → Code → Test → PR
git checkout -b feature/minha-feature
cd reference/node-fastify && npm run quality
git commit -m "feat: minha nova feature"
git push origin feature/minha-feature
```

### Branch Strategy

| Branch | Proposito |
|--------|-----------|
| `main` | Producao — codigo estavel e revisado |
| `develop` | Integracao — features prontas para proxima release |
| `staging` | Pre-producao — validacao final antes do merge em main |
| `feature/*` | Desenvolvimento de novas funcionalidades |
| `bugfix/*` | Correcao de bugs |
| `hotfix/*` | Correcoes criticas em producao |
| `release/*` | Preparacao de releases |
| `docs/*` | Atualizacoes de documentacao |

---

## 📖 Governanca

| Documento | Descricao |
|-----------|-----------|
| [`CHANGELOG.md`](CHANGELOG.md) | Historico de mudancas |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Guia de contribuicao |
| [`SECURITY.md`](SECURITY.md) | Politica de seguranca |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Modelo de governanca |
| [`RELEASE.md`](RELEASE.md) | Processo de release |
| [`SUPPORT.md`](SUPPORT.md) | Canais de suporte |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Codigo de conduta |
| [`LICENSE`](LICENSE) | Apache 2.0 |

---

## 🔐 Seguranca

- TLS 1.2+ obrigatorio em producao
- Webhooks assinados com HMAC SHA-256
- Dados sensiveis mascarados em logs
- Rotacao de secrets sem downtime
- Reporte vulnerabilidades via [`SECURITY.md`](SECURITY.md)

---

## 📄 Licenca

Este projeto e licenciado sob **Apache License 2.0** — veja [`LICENSE`](LICENSE) para detalhes.

---

<div align="center">

**Orqupay** — Pagamentos orquestrados com a inteligencia da orca. 🐋

[Documentacao](docs/) · [Issues](https://github.com/jardelva96/Orqupay/issues) · [Discussoes](https://github.com/jardelva96/Orqupay/discussions)

</div>
