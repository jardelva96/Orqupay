# Go-Live Checklist

## Seguranca

- [ ] TLS ativo em todos os endpoints
- [ ] chaves e segredos em cofre, sem plaintext
- [ ] assinatura de webhook validada
- [ ] logs sem dados sensiveis

## Confiabilidade

- [ ] idempotencia ativa em criacao/captura/reembolso
- [ ] retries e circuit breaker configurados
- [ ] fila de eventos e outbox monitoradas
- [ ] runbook de incidentes publicado

## Operacao

- [ ] dashboards de latencia, erro e aprovacao
- [ ] alertas por SLO violado
- [ ] tracing habilitado ponta a ponta

## Compliance

- [ ] revisao PCI DSS (escopo aplicavel)
- [ ] plano formal de certificacao PCI DSS Level 1 com QSA definido
- [ ] readiness SOC 2 Type I concluido
- [ ] readiness ISO/IEC 27001:2022 concluido
- [ ] validacao LGPD/GDPR (base legal e retencao)
- [ ] trilha de auditoria de acoes criticas
- [ ] matriz de controles e evidencias atualizada (`ops/compliance/control-matrix.csv`)
- [ ] calendario de auditoria publicado (`ops/compliance/audit-calendar.md`)

## Continuidade de Negocio e DR

- [ ] politica formal de DR aprovada (`ops/dr/dr-policy.yaml`)
- [ ] runbook de DR validado (`ops/runbooks/disaster-recovery.md`)
- [ ] ultimo drill com medicao de RTO/RPO aprovado
- [ ] relatorio de drill arquivado em `ops/dr/reports/`

## Produto

- [ ] fluxo de chargeback definido
- [ ] politica de reembolso definida
- [ ] conciliacao diaria automatizada
