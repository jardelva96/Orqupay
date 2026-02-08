# Confianca Institucional (PCI, SOC 2, ISO 27001)

Baseline desta trilha em 2026-02-08.

Este documento organiza um programa auditavel para levar o PMC a padrao enterprise.

## Referencias oficiais

- PCI SSC: PCI DSS and Supporting Documents Library: <https://www.pcisecuritystandards.org/standards/pci-dss/>
- PCI SSC blog (cronograma e transicao para v4.0.1): <https://blog.pcisecuritystandards.org/bulletin-pci-dss-v4-0-revision-to-v4-0-1-and-an-update-on-saqs>
- AICPA SOC 2 overview: <https://www.aicpa-cima.com/topic/audit-assurance/aicpa-assurance-opportunities/soc-2>
- ISO 27001 page (ISO/IEC 27001:2022): <https://www.iso.org/standard/27001>
- NIST SP 800-34 Rev.1 (contingency planning): <https://csrc.nist.gov/pubs/sp/800/34/r1/final>
- NIST Cybersecurity Framework 2.0: <https://www.nist.gov/cyberframework>

## Sequencia recomendada (realista)

1. ISO/IEC 27001:2022 (fundacao de ISMS)
1. SOC 2 Type I (design dos controles em um ponto no tempo)
1. SOC 2 Type II (efetividade operacional ao longo de periodo)
1. PCI DSS Level 1 (QSA + ROC/AOC conforme escopo de dados de pagamento)

## Objetivos de maturidade

1. Governanca
- RACI formal de seguranca, risco e continuidade.
- Comitê mensal de risco/compliance com atas versionadas.

1. Controles
- Matriz unica de controles mapeada para PCI DSS, SOC 2 e ISO 27001.
- Evidencias com owner, frequencia, local e retencao.

1. Operacao
- Runbooks testados para incidente de seguranca e DR.
- Teste de DR com RTO/RPO medidos e aprovados pela diretoria tecnica.

## Plano de 180 dias (pratico)

1. Dias 0-30
- Definir escopo CDE (Cardholder Data Environment) e fronteiras de rede.
- Consolidar inventario de ativos, dados e terceiros.
- Publicar politicas obrigatorias: acesso, criptografia, logging, backup, change, incident, BCP/DR.

1. Dias 31-60
- Fechar lacunas de IAM (MFA, least privilege, periodic review).
- Harden de segredos e chaves (KMS/Vault, rotacao automatizada).
- Implantar trilha de auditoria para acao administrativa critica.

1. Dias 61-90
- Dry-run SOC 2 Type I + auditoria interna ISO 27001.
- Primeiro DR drill com alvo formal de RTO/RPO por tier.
- Ajustar runbooks com base em post-mortem.

1. Dias 91-120
- Auditoria externa SOC 2 Type I.
- Iniciar janela de observacao SOC 2 Type II.
- Pre-assessment PCI DSS com QSA.

1. Dias 121-180
- SOC 2 Type II readiness (operacao continua, evidencias fechadas).
- PCI DSS Level 1 assessment readiness (ROC/AOC, ASV, pentest, segmentation test).

## Definicao de escopo (evita reprova em auditoria)

1. Em escopo obrigatorio
- API de pagamentos, webhooks, stores de idempotencia/eventos.
- Infra cloud, rede, CI/CD, secrets, observabilidade e runbooks.

1. Evidencia minima obrigatoria
- Politicas assinadas e revisadas.
- Logs de mudanca e aprovacao.
- Evidencias de backup/restore.
- Evidencias de testes de resposta a incidente.
- Evidencias de DR drill com RTO/RPO.

## KPIs de confianca institucional

1. Cobertura de controles: >= 95% com owner e evidencia valida.
1. Acoes corretivas vencidas: <= 5%.
1. Drill DR trimestral: 100% executado.
1. Sucesso em RTO/RPO: >= 95% dos drills.

## Entregaveis no repositorio

- `ops/compliance/control-matrix.csv`
- `ops/compliance/evidence-register.csv`
- `ops/compliance/audit-calendar.md`
- `ops/runbooks/disaster-recovery.md`
- `ops/runbooks/security-incident.md`
- `ops/runbooks/key-compromise.md`

## Nota

Este material e um baseline tecnico-operacional e nao substitui assessoramento juridico, QSA ou auditor independente.
