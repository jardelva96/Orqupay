# Runbook: Security Incident Response

## Trigger

Acionar para suspeita ou confirmacao de:

1. Comprometimento de credenciais privilegiadas.
1. Exposicao de dados sensiveis.
1. Alteracao nao autorizada em sistemas de pagamento.
1. Indicador de intrusao em ambiente de producao.

## Metas operacionais

1. Contencao inicial em ate 15 minutos para `SEV-1`.
1. Classificacao tecnica em ate 60 minutos.
1. Comunicacao executiva inicial em ate 90 minutos.

## Responsaveis

- Incident Commander
- Security Lead
- Forensics Lead
- Legal/Privacy Lead
- Communications Lead

## Fluxo de resposta

1. Identificar e classificar severidade.
1. Preservar evidencias forenses (logs, snapshots, hashes).
1. Conter impacto:
- revogar acessos suspeitos
- rotacionar segredos expostos
- bloquear rotas maliciosas
1. Erradicar causa raiz.
1. Recuperar servicos com monitoramento reforcado.

## Comunicacao

1. Comunicar status interno em janela fixa (ex.: cada 30 minutos).
1. Avaliar obrigacoes regulatorias de notificacao.
1. Registrar decisao juridica e de privacidade.

## Evidencias

1. Timeline detalhada.
1. Escopo de dados impactados.
1. Acoes de contencao e recuperacao.
1. Decisoes juridicas e comunicacao externa.

## Pos-incidente

1. Post-mortem sem culpa.
1. Plano de acao com prioridade e prazo.
1. Verificacao de recorrencia em 30 dias.
