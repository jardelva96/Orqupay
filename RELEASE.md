# Release Process

## Versioning

Use Semantic Versioning:

- `MAJOR`: breaking contract changes
- `MINOR`: backward-compatible features
- `PATCH`: fixes and non-breaking internal improvements

## Steps

1. ensure `npm run quality` is green
2. update `CHANGELOG.md`
3. verify distributed benchmark (`PMC_PAYMENT_BACKEND=postgres`, `PMC_EVENT_BUS_BACKEND=durable`)
4. create release tag (`vX.Y.Z`)
5. push tag to trigger `.github/workflows/release.yml`
6. publish release notes with migration impact
7. verify GHCR image `ghcr.io/<owner>/pmc-reference-node-fastify:<tag>`

## Release Artifacts

- GitHub Release notes (auto-generated + changelog details)
- Docker image (multi-arch) from `reference/node-fastify/Dockerfile`
- SBOM artifact from `.github/workflows/security.yml`

## Contract Changes

Any breaking API/event change requires:

- new major contract version
- explicit migration notes in docs
