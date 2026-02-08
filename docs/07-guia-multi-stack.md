# Guia Multi-Stack

Este modulo foi desenhado para qualquer linguagem/framework porque o contrato e externo ao codigo.

## Contratos que todos devem respeitar

1. HTTP API: `contracts/openapi/payment-module.v1.yaml`
2. Eventos: `contracts/asyncapi/payment-events.v1.yaml`
3. Payloads: `schemas/*.json`

## Estrutura recomendada por implementacao

```text
src/
  api/
  application/
  domain/
  ports/
  adapters/
  infra/
```

## Ports obrigatorios

- `PaymentRepositoryPort`
- `ProviderGatewayPort`
- `RiskEnginePort`
- `EventBusPort`
- `IdempotencyStorePort`

## Mapeamento por linguagem

- Node/Nest/Fastify: interfaces em `ports/` + providers por injecao
- Java/Spring: interfaces + adapters `@Service/@Component`
- Go: interfaces + structs em pacotes `ports` e `adapters`
- .NET: interfaces + DI container nativo
- Python/FastAPI/Django: protocolos/abstracoes + adapters concretos

## Regra de ouro

Trocar framework nao pode quebrar dominio. Trocar PSP nao pode quebrar API publica.

## Referencia pronta para copiar padrao

Use `reference/node-fastify/` como baseline tecnico para qualquer stack.

- comandos: `npm install` e `npm run quality`
- qualidade minima: typecheck + testes + contract check
