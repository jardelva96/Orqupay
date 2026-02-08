# Design Patterns Aplicados

## 1. Strategy: Provider Routing

Escolhe o melhor PSP por regras de negocio:

- menor custo
- menor latencia
- maior taxa de aprovacao
- failover automatico

## 2. State Machine: Payment Lifecycle

Estados canonicos:

- `requires_confirmation`
- `processing`
- `requires_action`
- `succeeded`
- `failed`
- `canceled`
- `refunded` (derivado por operacoes de reembolso)

## 3. Chain of Responsibility: Risk Pipeline

Cada regra de risco decide:

- `allow`
- `review`
- `deny`

Regras sao encadeadas e reutilizaveis.

## 4. Outbox Pattern: Consistencia de Eventos

Evento e gravado na mesma transacao do dado principal e publicado de forma assincrona.

## 5. Saga: Fluxos distribuidos

Para operacoes com multiplos servicos (captura, split, repasse), usa compensacoes explicitas.

## 6. Circuit Breaker + Retry

Evita cascata de falhas em provedores externos e aplica retry com backoff.

## 7. Adapter Pattern

Cada PSP e implementado como adaptador independente, isolando mudancas de API externa.

## 8. Idempotency Key

Chave por operacao critica para evitar dupla cobranca.

