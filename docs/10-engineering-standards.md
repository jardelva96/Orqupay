# Engineering Standards

## Quality Gates

No merge sem passar:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run test:coverage`
4. `npm run contracts:check`
5. `npm run events:check`

Atalho local:

```bash
npm run quality
```

Na CI:

- matriz Node `20`, `22`, `24`
- job separado para benchmark comparativo
- job semanal de DR drill em ambiente duravel

## Coverage Policy

Cobertura minima na referencia Node:

- lines >= 70%
- statements >= 70%
- functions >= 70%
- branches >= 60%

## Contract Governance

- API HTTP: `contracts/openapi/payment-module.v1.yaml`
- Eventos: `contracts/asyncapi/payment-events.v1.yaml`
- Payloads: `schemas/*.json`

Mudanca breaking exige major.

## Performance Comparison

Benchmark comparativo:

```bash
npm run benchmark:compare
```

Cenarios:

1. autorizacao direta
2. autorizacao com failover

Observacao: a referencia usa adapters in-memory; resultados de latencia servem para regressao relativa, nao para sizing de producao.

Guardrails opcionais de regressao:

- `BENCH_FAILOVER_MAX_AVG_DELTA_MS`
- `BENCH_FAILOVER_MAX_P95_DELTA_MS`
- `BENCH_OUTPUT_FILE` (saida JSON para CI e historico)

## DR e Confianca Institucional

Teste de DR (com RTO/RPO):

```bash
npm run dr:drill
```

Variaveis de controle:

- `DR_SAMPLE_SIZE`
- `DR_SIMULATED_OUTAGE_SECONDS`
- `DR_RTO_TARGET_SECONDS`
- `DR_RPO_TARGET_SECONDS`
- `DR_OUTPUT_FILE`
