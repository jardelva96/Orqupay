# Runbooks Formais e DR (RTO/RPO)

## Objetivo

Padronizar resposta operacional para incidentes severos e desastres, com medicao formal de RTO/RPO.

## Modelo de severidade

1. `SEV-1`: indisponibilidade critica ou risco regulatorio imediato.
1. `SEV-2`: degradacao significativa com risco de impacto financeiro.
1. `SEV-3`: falha parcial sem indisponibilidade ampla.

## Metas por tier

1. `Tier-0` (autorizacao, captura, refund, webhooks):
- `RTO <= 300s`
- `RPO <= 60s`

1. `Tier-1` (consultas e reconciliacao near real-time):
- `RTO <= 900s`
- `RPO <= 300s`

1. `Tier-2` (batch analitico):
- `RTO <= 14400s`
- `RPO <= 3600s`

## Cadencia de testes

1. Drill tecnico mensal (engenharia/SRE).
1. Game day trimestral multi-time (engenharia, seguranca, suporte, produto).
1. Simulado anual com auditoria interna e sign-off executivo.

## Padrao minimo de runbook

1. Trigger (quando acionar).
1. Escopo do impacto.
1. Responsaveis (Incident Commander, Ops Lead, Security Lead, Comms).
1. Checklist de mitigacao.
1. Checklist de recuperacao.
1. Criterio de encerramento.
1. Post-mortem com acoes corretivas.

## Artefatos do repositorio

- Runbooks: `ops/runbooks/*.md`
- Politica DR: `ops/dr/dr-policy.yaml`
- Template de evidencia: `ops/dr/dr-drill-template.md`
- Script de drill: `reference/node-fastify/scripts/dr-drill.ts`

## Execucao tecnica (referencia)

1. Subir stack duravel (PostgreSQL + Redis).
1. Rodar migracoes.
1. Executar drill com ambiente em modo distribuido.
1. Publicar relatorio JSON do drill no registro de evidencias.

Comandos:

```bash
cd reference/node-fastify
docker compose -f docker-compose.durable.yml up -d
PMC_POSTGRES_URL=postgres://postgres:postgres@localhost:55432/pmc npm run db:migrate
PMC_IDEMPOTENCY_BACKEND=postgres \
PMC_RATE_LIMIT_BACKEND=redis \
PMC_EVENT_BUS_BACKEND=durable \
PMC_POSTGRES_URL=postgres://postgres:postgres@localhost:55432/pmc \
PMC_REDIS_URL=redis://localhost:56379 \
DR_OUTPUT_FILE=../../ops/dr/reports/latest-dr-drill.json \
npm run dr:drill
```

PowerShell:

```powershell
cd reference/node-fastify
docker compose -f docker-compose.durable.yml up -d
$env:PMC_POSTGRES_URL = "postgres://postgres:postgres@localhost:55432/pmc"
npm run db:migrate
$env:PMC_IDEMPOTENCY_BACKEND = "postgres"
$env:PMC_RATE_LIMIT_BACKEND = "redis"
$env:PMC_EVENT_BUS_BACKEND = "durable"
$env:PMC_REDIS_URL = "redis://localhost:56379"
$env:DR_OUTPUT_FILE = "..\\..\\ops\\dr\\reports\\latest-dr-drill.json"
npm run dr:drill
```
