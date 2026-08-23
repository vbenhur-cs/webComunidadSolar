# Phase 3 — Task 6 report

## Scope and preflight

- Base checked before implementation: `edfeed5ea0542367be88bb1f00699075b6220aa7`.
- The worktree was clean and the pinned source guard reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean` before and after
  the work.
- The immutable source blobs for the D1 schema, migration, Drizzle config,
  interest endpoint, and database helper were read through the pinned
  source-reference flow only. The sibling checkout and its process group
  `49166` were never written, built, or terminated.
- Scope is limited to the Manganáfer interest endpoint, its single canonical
  migration, local-D1 integration helper, and focused tests. No route matrix,
  visual baseline, public page, or HTTP-baseline record was changed.

## TDD and implementation

1. The initial focused server test was RED with the interest module absent.
   It now covers missing/object/array/primitive payload roots, field types and
   bounds, `Content-Length: 24001`, a genuinely oversized body without that
   header, invalid JSON, a failed stream read, lower-cased email, persistence
   defaults, the honeypot, generic D1 failure, and idempotent `(email, kind)`
   upsert behaviour.
2. Source-observable compatibility is preserved: a JSON `null` root returns an
   empty generic `500`; arrays and other invalid JSON roots return their
   factual validation `400`. This is inherited behaviour, not a new API
   recommendation. Task 6 explicitly hardens the source's header-only limit
   into an effective `24 KiB` bound while reading the real stream; the handler
   cancels an oversized reader before D1 is touched.
3. There is one physical `CREATE TABLE` statement: in
   `drizzle/0000_fat_wolfsbane.sql`. `ensureManganaferInterestStorage()` imports
   that SQL with `?raw`, splits its declared statement breakpoints, and batches
   precisely those statements. The schema/client use the same table and the
   unique email/kind key.
4. The first integration RED lacked the local-D1 helper. Its GREEN proves both
   supported paths against an isolated `mkdtemp` D1: migration CLI then upsert,
   and an empty D1 where the endpoint itself creates the canonical table and
   indexes before persisting.
5. Lifecycle review added deterministic injected and real-POSIX coverage:
   selected configuration/environment argv, spawn failure before readiness,
   non-cooperative readiness timeout, primary-error preservation, Windows
   fail-closed behaviour, and a TERM-resistant descendant after its leader
   exits. The helper owns a detached POSIX process group and uses bounded
   TERM-to-KILL cleanup; it never selects a remote D1.
6. The selected source config (`CLOUDFLARE_CONFIG_PATH` or `wrangler.jsonc`)
   is used for build, migration, and D1 queries. The emitted Wrangler deploy
   config is intentionally used for `wrangler dev --no-bundle`: the source
   config cannot resolve emitted chunk imports, while the generated topology
   can. `--env`, `--assets dist`, `--local`, and the isolated persist directory
   remain explicit.
7. `drizzle-kit` is pinned exactly to `0.31.10`, with `test:integration` and
   `db:generate` scripts. The lockfile changed mechanically as npm 10.9.8
   regenerated the dependency tree: a clean `npm install --package-lock-only
   --ignore-scripts` reproduced SHA-256
   `f9f5e22ca64898d20b750c7ea994d276c601c338f12435e183ce715add38e7ca`, and an
   isolated `npm ci --ignore-scripts` passed. This explains its larger but
   deterministic diff.

## Verification ledger

- Focused initial server RED: `ERR_MODULE_NOT_FOUND` for
  `src/lib/manganafer/interest.ts`.
- Final focused server and helper suite: PASS (`18/18`).
- Local isolated D1 integration: PASS (`2/2`): migration/upsert and runtime
  bootstrap from an empty D1.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS, 0 errors and three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the
  source-faithful deprecated iframe `scrolling` attribute).
- `npm test`: PASS (`239/239`, 0 failures, 48.384 s).
- `npm run build`: PASS.
- `npm run test:integration`: PASS (`2/2`, 40.480 s).
- `npm run source:check`: PASS —
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- `npm run parity:manifest -- --check`: PASS — `SOURCE_MANIFEST_OK 271`.
- `npx tsx scripts/capture-http-baseline.ts --check`: PASS —
  `HTTP_BASELINE_OK 311 81`. The Task 6 endpoint has no frozen public
  baseline/matrix row, so no parity HTTP/visual capture or matrix promotion is
  applicable.

## Self-review and cleanup

- The requested duplicate null-status assertion was audited: exactly one
  assertion remains, preserving coverage for the inherited null-root `500`.
- A direct source audit finds exactly one physical `CREATE TABLE` statement in
  the canonical migration.
- `git diff --check` is clean. The only touched product/test/config paths are
  the Task 6 files listed in the plan plus `package-lock.json` and this report.
- `.dev.vars` is absent. No owned local D1 directory, Worker, preview process,
  or descendant remains. The only matching running processes are the intact
  pre-existing source group `49166`.
- Tests and this report contain no real email, name, phone, address, or private
  response body. Test identities and payloads are synthetic.

## Commit

`npm run verify:independent -- --staged` passed with `INDEPENDENT_OK`. The
final staged tree is paused for cached review before the requested commit:

```text
feat: persist Manganáfer interests in D1
```
