# Roadmap

## Fase 1: Foundation (atual)

- contratos canonicos (`OpenAPI`, `AsyncAPI`, `JSON Schema`)
- arquitetura `HOPA`
- implementacao de referencia (`Node + Fastify`)
- autenticacao por API key (`Bearer`)
- risk engine plugavel (`allow/review/deny`)
- failover de autorizacao entre provedores
- testes de fluxo critico e quality gate

## Fase 2: Producao

- persistencia real (PostgreSQL)
- outbox transacional + broker (Kafka/RabbitMQ)
- baseline duravel implementado na referencia com PostgreSQL + Redis Streams (outbox/inbox)
- autenticacao de API por chave/assinatura
- observabilidade completa (OpenTelemetry + Prometheus)
- programa de confianca institucional (PCI DSS, SOC 2, ISO 27001) com matriz de controles e evidencias
- runbooks formais e DR drill com medicao de RTO/RPO

## Fase 3: Escala e ecossistema

- SDKs oficiais (TypeScript, Python, Go, Java, .NET)
- plugins de provedores reais
- reconciliacao automatica e relatorios
- painel administrativo e runbooks SRE
