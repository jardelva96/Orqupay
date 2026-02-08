# Runbook: API Key or Secret Compromise

## Trigger

Acionar quando houver indicio de exposicao de:

1. API keys de cliente.
1. Segredos de assinatura de webhook.
1. Credenciais de banco, broker ou cache.

## Objetivo

Interromper uso indevido e concluir rotacao total sem downtime relevante.

## Checklist imediato (0-15 min)

1. Marcar incidente `SEV-1` se houver abuso ativo.
1. Revogar chave comprometida.
1. Ativar chave secundaria/rotacionada.
1. Aplicar bloqueio no rate limit para token suspeito.

## Checklist de remediacao

1. Rotacionar no cofre de segredos.
1. Atualizar configuracao dos servicos.
1. Validar autenticacao e assinaturas apos rotacao.
1. Confirmar ausencia de uso da credencial comprometida.

## Validacao tecnica

1. Operacao mutante com nova API key deve responder `2xx`.
1. Operacao com chave antiga deve responder `401`.
1. Webhook assinado com segredo antigo deve falhar validacao no consumidor.

## Evidencias

1. Ticket de incidente.
1. Logs de revogacao e rotacao.
1. Janela de impacto e mitigacao.
1. Aprovacao final do Security Lead.
