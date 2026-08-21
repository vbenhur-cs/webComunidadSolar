# Task 5 — HTTP parity and route-before-Astro Worker entry

## Delivered behavior

- Copied the immutable committed source blob `app/legacy-routes.ts` to
  `src/lib/routing/legacy.ts` through Task 2's `copySourceFiles` API.  Its
  provenance records source commit
  `68ea294c54dc5e15e20f470fc421a239927565a8`, SHA-256
  `d5daefb7774b8f0c6ddfa81fd29138ebb073ebb49e0715a6b311c052d292cff2`,
  and `19895` bytes.
- Added `routeBeforeAstro(request)`, which returns exact legacy 410 responses
  before Astro and preserves redirects with `new URL(to, url.origin)` followed
  by `destination.search = url.search`.  The 19 gone paths return status 410,
  `cache-control: public, max-age=3600`,
  `content-type: text/plain; charset=utf-8`, `x-robots-tag: noindex`, and the
  captured Spanish body.  All 103 redirects return 308 with the captured
  location and cache header, including query-plus-fragment ordering.
- Added the official Astro 7 deploy entry `src/fetch.ts`.  It routes before
  calling `astro(new FetchState(request))`.  The retained `src/worker.ts` is a
  thin direct-Wrangler compatibility wrapper using the same
  `routeBeforeAstro` implementation and `@astrojs/cloudflare/handler`; route
  data and routing logic are not duplicated.
- Added `scripts/parity-http.ts`: a build-once foundation CLI and injectable
  unit core.  It compares status, all Task 4 allowlisted captured headers, the
  capture discriminator, body hash, normalized public text, and JSON shape.
  It only selects `redirect` and `gone` contracts.  It reads the Task 4
  discriminated contracts/deferred entries safely: suppressed private-success
  bodies and artifact paths are never read or emitted in a diff.

## TDD evidence

The two focused test files were created before production modules.  The first
run was the required RED:

```bash
npm run test:unit -- tests/foundation/worker-routing.test.ts tests/parity/http-compare.test.ts
```

It exited 1 with the expected `ERR_MODULE_NOT_FOUND` errors for
`src/lib/routing/before-astro.ts` and `scripts/parity-http.ts`.

After source inspection through Task 2's committed-blob Git API, copying the
blob, and implementing the route and comparator modules, the same focused
suite reached GREEN: **13/13** passing.  It covers gone precedence, exact
headers/body, query strings and normalization, broad Elementor gone handling,
public diffs, suppressed private-body safety, foundation-only selection,
matrix scoping, generated-topology resolution, injected-runtime cleanup,
single-build injection, and the real built-Worker smoke.

## Built Worker and smoke evidence

The obsolete direct Node import path was not used.  The CLI builds once and
resolves the generated chain:

```text
.wrangler/deploy/config.json
  -> dist/server/wrangler.json (main: entry.mjs)
  -> dist/server/entry.mjs
```

It executes that exact configuration and emitted entry through Wrangler
`unstable_startWorker` on loopback only (`127.0.0.1`; request origin
`http://localhost`), with `remote: false`, `persist: false`, and `watch:
false`.  Redirect requests deliberately use `redirect: "manual"`, so the
comparator observes the Worker’s 308 instead of following it into a later Astro
page.  The runtime is disposed in `finally`; the failure-path unit test proves
the cleanup call and the real smoke completed with `disposed=true`.  No
publish/deploy, direct `cloudflare:workers` import, external service, or source
checkout build was used.

The real smoke asserts that the generated entry contains `src/fetch.ts` and
`routeBeforeAstro`, and that the generated Wrangler config selects `entry.mjs`.
It passed through the emitted Worker with these exact results:

```text
HTTP_PARITY_OK scope=foundation contracts=225 verified=122 pending=149 ... disposed=true
```

The 225 contracts are 206 redirect variants (103 paths with default and query
variants) plus 19 gone routes.  Only the 122 corresponding route-matrix rows
were changed to `verified`; all 149 remaining rows, including `/` and every
later-phase page/API/private/asset route, remain `pending`.

## Verification

- Focused Task 5 tests: **13/13** passing.
- Full unit suite: `npm test` — **48/48** passing.
- `npm run parity:http -- --scope foundation` — passed with **225 contracts,
  122 verified, 149 pending**.
- `npm run format:check` and `npm run lint` — passed.
- `npm run check` and `npm run build` — passed with Astro reporting 0 errors
  and 0 warnings; the only output is the repository's pre-existing
  TypeScript-ESLint deprecation hint.
- `npm run parity:manifest -- --check` — `SOURCE_MANIFEST_OK 271`.
- `npx tsx scripts/capture-http-baseline.ts --check` —
  `HTTP_BASELINE_OK 311 81`.
- `npm run source:check` before the real baseline check —
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- `git diff --check` — passed.  The final source guard and staged whitespace
  check are run again immediately before commit.

## Self-review and concerns

Reviewed every Task 5 brief item and the subsequent rulings: initial RED,
committed-source-only copy/provenance, exact legacy response behavior,
single pre-Astro route implementation in both entries, comparator field and
privacy behavior, deferred-contract parsing, foundation-only matrix updates,
build-once modern deploy topology, actual workerd smoke, loopback/no-deploy
runtime, cleanup, and deterministic verification counts.

No blocking concern remains.  `unstable_startWorker` is explicitly an unstable
Wrangler API, but it is exercised against the pinned project Wrangler version
(`4.125.0`) in the required smoke rather than being assumed through a mocked or
direct-import path.
