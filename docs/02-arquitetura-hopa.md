# Arquitetura HOPA

`HOPA` (`Hybrid Orchestrated Payment Architecture`) e uma arquitetura orientada a contratos, eventos e plugins.

## Camadas

1. `API Layer`
- recebe requisicoes externas
- valida contrato e idempotencia

2. `Orchestrator Layer`
- controla state machine do pagamento
- aplica politicas (risco, roteamento, retry)

3. `Domain Layer`
- entidades: `PaymentIntent`, `Charge`, `Refund`, `Dispute`
- invariantes e regras de negocio

4. `Ports Layer`
- interfaces estaveis para persistencia, mensageria, PSP, risco e notificacao

5. `Adapters Layer`
- implementacoes concretas por tecnologia/provedor
- cada adaptador e isolado e substituivel

## Diagrama logico

```text
Client -> API -> Orchestrator -> Domain Rules
                           |-> Risk Port -> Risk Adapter
                           |-> Provider Port -> PSP Adapter A/B
                           |-> Repository Port -> DB Adapter
                           |-> Event Port -> Queue/Webhook Adapter
```

## Componentes principais

- `Payment Orchestrator`
- `Provider Router`
- `Risk Pipeline`
- `Ledger/Reconciliation Engine`
- `Webhook Dispatcher`
- `Outbox Publisher`

## Estabilidade cross-language

Para funcionar em qualquer stack:

- contrato HTTP em `OpenAPI`
- contrato de evento em `AsyncAPI`
- payloads em `JSON Schema`
- sem dependencia de runtime especifico

## Niveis de extensao

1. `Core`: fluxo de pagamento padrao
2. `Plugin`: novos provedores/metodos
3. `Policy`: regras de risco e roteamento
4. `Ops`: alertas, observabilidade, SLO

## ADR relacionada

Ver `adr/0001-hopa-arquitetura.md`.
