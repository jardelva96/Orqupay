# Governance

## Decision Model

Architecture and contract changes are reviewed through:

1. issue or proposal
2. design discussion
3. implementation PR
4. ADR update when relevant

## Maintainer Responsibilities

- protect backward compatibility
- enforce security and quality gates
- publish release notes and migration guidance

## Quality Policy

Changes are merged only when:

- CI is green
- `npm run quality` passes
- contract changes are documented in `docs/` and `contracts/`

