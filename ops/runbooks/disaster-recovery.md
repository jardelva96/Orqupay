# Runbook: Disaster Recovery

## Trigger

Acionar quando houver indisponibilidade de `Tier-0` acima de 5 minutos, perda de regiao, corrupcao de dados ou falha total de dependencia critica.

## Objetivo

Restaurar servico dentro dos alvos formais:

- `RTO <= 300s` para Tier-0
- `RPO <= 60s` para Tier-0

## Responsaveis

- Incident Commander (IC)
- Ops Lead (infra/DB)
- App Lead (engenharia aplicacao)
- Security Lead
- Communications Lead

## Checklist de resposta

1. Declarar incidente e abrir bridge de crise.
1. Congelar deploys em producao.
1. Confirmar escopo: regiao, servicos, banco, broker, cache.
1. Ativar plano de failover para stack secundaria.
1. Garantir que trilhas duraveis estao ativas:
- PostgreSQL para idempotencia/outbox/inbox
- Redis para streams/rate-limit

## Checklist de recuperacao

1. Validar saude:
- `/health/live`
- `/health/ready`
- latencia p95 e taxa de erro
1. Executar transacao sintetica de pagamento.
1. Validar continuidade dos eventos:
- sem perda de eventos confirmados antes da interrupcao
1. Reabrir trafego progressivo (10%, 25%, 50%, 100%).
1. Confirmar estabilidade por 30 minutos.

## Evidencias obrigatorias

1. Linha do tempo com timestamps UTC.
1. RTO medido.
1. RPO medido.
1. Lista de acoes corretivas com owner e prazo.

## Encerramento

Encerrar incidente apenas com:

1. Alvos de RTO/RPO reportados.
1. Aprovacao do IC.
1. Post-mortem agendado em ate 5 dias uteis.
