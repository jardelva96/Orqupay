# Contributing

Obrigado por contribuir com o `Payment Module Core`.

## Como contribuir

1. Abra issue descrevendo problema/proposta
2. Proponha mudanca pequena e objetiva por PR
3. Garanta compatibilidade com contratos existentes
4. Inclua testes de contrato quando aplicavel

## Padroes obrigatorios

- versionamento semantico (`SemVer`)
- mudancas breaking apenas em versao major
- `Idempotency-Key` obrigatoria em operacoes sensiveis
- logs sem dados sensiveis (`PAN`, `CVV`, segredos)

## Padrao de commit

Recomendado usar Conventional Commits:

- `feat:`
- `fix:`
- `refactor:`
- `docs:`
- `test:`

## Validacao local obrigatoria

Na implementacao de referencia (`reference/node-fastify`):

```bash
npm run quality
```

Opcional para comparacao de performance:

```bash
npm run benchmark:compare
```

## Checklist de PR

- [ ] alteracao documentada em `docs/`
- [ ] contrato atualizado em `contracts/` quando necessario
- [ ] schema atualizado em `schemas/` quando necessario
- [ ] impacto de backward compatibility documentado
