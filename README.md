# Comunidad Solar — Astro foundation

This repository is the Astro/Cloudflare foundation for the Comunidad Solar
migration. It requires Node 22 and npm:

```bash
npm ci
npm run check
npm test
npm run build
```

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
