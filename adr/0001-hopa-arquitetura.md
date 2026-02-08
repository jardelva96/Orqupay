# ADR 0001: Adocao da arquitetura HOPA

- Status: Aceito
- Data: 2026-02-07

## Contexto

Precisamos de um modulo de pagamentos open source:

- portavel entre linguagens e frameworks
- resiliente a falhas de provedores
- simples para comecar e extensivel para empresas grandes

## Decisao

Adotar `HOPA` (Hybrid Orchestrated Payment Architecture):

- `Ports & Adapters` para isolar tecnologia/provedor
- contratos canonicos em `OpenAPI`, `AsyncAPI` e `JSON Schema`
- `Orchestrator` central com state machine e politicas plugaveis
- padroes obrigatorios: idempotencia, outbox, retries, circuit breaker

## Consequencias

### Positivas

- implementavel em qualquer stack
- menor risco de lock-in de provedor
- evolucao controlada por contratos versionados

### Custos

- aumento inicial de complexidade arquitetural
- necessidade de governanca de contratos e eventos

