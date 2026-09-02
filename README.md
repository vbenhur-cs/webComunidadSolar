# Comunidad Solar — Astro foundation

This repository is the Astro/Cloudflare foundation for the Comunidad Solar
migration. It requires Node 22 and npm:

```bash
npm ci
npm run check
npm test
npm run build
```

Pull requests and pushes to `main` run
[`production-readiness`](.github/workflows/verify.yml). The required check
covers static quality, unit/server contracts, local D1, the real development
server, public browser contracts, link closure, a clean Git-archive rebuild and
a Cloudflare dry deployment. It never deploys or reads production secrets.

`npm run source:check` protects the immutable reference checkout. The sibling
is a read-only parity oracle only: production, builds, previews and the
autonomous verifier do not depend on it. The generated Wrangler topology is
checked by `npm run check`; `npm run deploy:dry` prepares a deterministic local
Cloudflare profile, builds it, and checks the emitted topology without invoking
a deploy command or network client.

Parity evidence is versioned and can be refreshed or checked with:

```bash
npm run parity:manifest -- --check
npm run parity:http -- --scope foundation
npm run parity:visual -- --scope foundation --allow-pending
```

The current home route is deliberately a Phase 1 smoke: its desktop, tablet
and mobile visual results are three `pending` records, not a claim of visual
parity. Later migration phases own the route-by-route conversion and the
ingestion/publication layer.

To prove the foundation can work without the sibling checkout, use an archive
of committed HEAD:

```bash
npm run verify:independent
```

Before committing a change, stage the intended files and verify that exact Git
tree instead:

```bash
npm run verify:independent -- --staged
```

The verifier rejects untracked or unstaged project files, creates a private Git
archive without `.git` or a sibling checkout, and runs `npm ci`, check, test,
and build inside it. Agents and automation do not publish directly; later
migration and ingestion work still require their approved gates.

## Ingestión de páginas verificable

El flujo de ingestión recibe una solicitud o página aportada, exige Gate 1,
genera y valida un candidato sellado, y exige Gate 2 antes de cualquier
operación posterior. La CLI productiva acepta sólo los adaptadores `codex` y
`command`; una aprobación pendiente termina con código 2 y un comando o
adaptador prohibido con código 3.

```bash
npm run ingest -- receive request examples/requests/page-request.yaml
npm run ingest -- plan ejemplo-autoconsumo-compartido
npm run ingest -- approve ejemplo-autoconsumo-compartido --gate 1 --actor operador-responsable
npm run ingest -- generate ejemplo-autoconsumo-compartido --adapter command
npm run ingest -- validate ejemplo-autoconsumo-compartido
npm run ingest -- preview ejemplo-autoconsumo-compartido --check-only
npm run verify:ingestion
```

Los fixtures de ingestión se ejecutan sólo en clones temporales y no son parte
de la CLI de producción. `--execute` no autoriza un deploy y Cloudflare real
sigue cerrada. Consulte [la guía operativa de ingestión](docs/operations/ingestion.md)
para estados, evidencia, configuración de `CommandAgent` y recuperación de una
reconciliación pendiente.

Cuando se autorice la grabación de fixtures, sus expedientes saneados viven en
`changes/<change-id>/` y se auditan junto con el tag de candidato asociado; las
entradas y builds bajo `.artifacts/` nunca se versionan como evidencia.
El tag anotado sella el commit del candidato, el sujeto compuesto de Gate 2 y
los hashes canónicos de la proyección saneada y de todos los bytes del
expediente. Cada dossier incluye `candidate-manifest.json`, una preimagen
canónica con schema cerrado: guarda hashes de valores sensibles (rutas,
comandos, URL, evidencia y diferencias), nunca sus valores en claro, para que
la auditoría pueda recalcular el sello tras destruir el clon. La grabación
conserva el gate `main == HEAD`; no adelanta, fusiona ni relaja `main`.

Para que un expediente sea durable, `candidate.json`, la preimagen y el intento
deben conservar en cada validación el mismo ID, orden y `evidenceSha256`, y
estar en estado `passed`. El candidato y el intento conservan sólo la referencia
lógica fija `evidence/<id>.json` y ese digest, nunca los bytes ni la ruta de
origen de la evidencia. Un Gate 2 de un candidato legado sin evidencia grabable no
autoriza `--record` ni la auditoría; añadir los digests después modifica su
sujeto y requiere un Gate 2 nuevo.

`npm run verify:ingestion` abre sólo el grafo de auditoría durable: no inicia
agentes ni acepta su configuración. Sus errores y JSON usan esquemas de salida
allowlisted; valores no clasificados, bytes, rutas o secretos nunca se
imprimen.

Para la operación cotidiana, la habilitación inicial de Cloudflare y las
entregas posteriores, consulte el [runbook de pruebas y producción](docs/operations/production-release-runbook.md).
