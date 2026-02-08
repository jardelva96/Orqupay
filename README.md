# Payment Module Core (PMC)

Modulo de pagamentos open source, API-first, pronto para qualquer linguagem e framework.

## Objetivo

Entregar um padrao de mercado para pagamentos com:

- contratos estaveis (`OpenAPI`, `AsyncAPI`, `JSON Schema`)
- arquitetura desacoplada (`Ports & Adapters`)
- resiliencia e observabilidade por padrao
- configuracao avancada so no final da jornada do dev

## Arquitetura Propria: HOPA

`HOPA` significa `Hybrid Orchestrated Payment Architecture`.

Principios:

- `Hybrid`: suporta modos sync (API) e async (eventos/webhooks)
- `Orchestrated`: um orquestrador central controla fluxo, regras e roteamento
- `Payment`: dominio modelado por estados, idempotencia e conciliacao
- `Architecture`: agnostica de linguagem, framework e banco

Detalhes em `docs/02-arquitetura-hopa.md`.

## Estrutura

- `docs/` documentacao por trilha de adocao
- `contracts/openapi/` contrato HTTP
- `contracts/asyncapi/` contrato de eventos
- `schemas/` contratos JSON reutilizaveis
- `examples/` configuracoes modelo
- `ops/` operacao, compliance, runbooks e DR evidence
- `adr/` decisoes arquiteturais
- `reference/node-fastify/` implementacao de referencia executavel

## Jornada recomendada para devs

1. `docs/01-quickstart.md`
2. `docs/02-arquitetura-hopa.md`
3. `docs/03-design-patterns.md`
4. `docs/04-contratos.md`
5. `docs/05-configuracao-avancada.md`
6. `docs/06-go-live-checklist.md`
7. `docs/07-guia-multi-stack.md`
8. `docs/08-roadmap.md`
9. `docs/09-webhooks.md`
10. `docs/10-engineering-standards.md`
11. `docs/11-mercado-e-gap.md`
12. `docs/12-confianca-institucional.md`
13. `docs/13-runbooks-e-dr.md`

## Implementacao de referencia

```bash
cd reference/node-fastify
npm install
npm run dev
```

Depois disso, siga o fluxo em `docs/01-quickstart.md`.

Qualidade profissional local:

```bash
cd reference/node-fastify
npm run quality
npm run benchmark:compare
npm run slo:chaos
npm run dr:drill
```

## Licenca

Este projeto usa `Apache-2.0`. Veja `LICENSE`.

## Governanca e operacao

- changelog: `CHANGELOG.md`
- contribuicao: `CONTRIBUTING.md`
- seguranca: `SECURITY.md`
- governanca: `GOVERNANCE.md`
- release: `RELEASE.md`
- suporte: `SUPPORT.md`
- CI: `.github/workflows/ci.yml`
- security scans + SBOM: `.github/workflows/security.yml`
- release pipeline (tag `vX.Y.Z`): `.github/workflows/release.yml`
