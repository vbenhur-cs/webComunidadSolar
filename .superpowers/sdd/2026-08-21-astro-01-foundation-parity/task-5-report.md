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

## Round 1 — HTTP semantic contracts and atomic matrix persistence

### Review fixes delivered

- Bumped `parity/http-contracts.json` and the typed/parser contracts to schema
  **v2**.  Each of its 308 captured, non-private responses now declares
  `bodyComparison: "exact"`; the three `suppressed-private-success` contracts
  have no body, artifact, comparison, or semantic field.
- Captured HTML responses now persist public
  `htmlSemantics: { canonical, robots, normalizedText }` before an artifact is
  written. Canonical `<link>` `href`s and `<meta name="robots">` contents
  retain duplicate document order. Attribute/tag case, quote style and order
  are accepted. Text excludes comments, `script`, and `style`, then joins text
  nodes and collapses whitespace. Common semicolon-terminated named entities
  (`amp`, `apos`, `gt`, `lt`, `nbsp`, `quot`) plus numeric code points are
  decoded; unknown entities stay literal deterministically.
- `compareHttpContract` remains pure and reports separate `bodyComparison`,
  `canonical`, `robots`, and `normalizedText` diffs. It compares
  `bodySha256` only when the expected contract is `exact`; a comparison-mode
  mismatch still reports independently. Its discriminant guard returns before
  reading any private body, artifact, or semantic value.
- Candidate captures use `.artifacts/http-candidate`; expected captures remain
  `.artifacts/http-baseline`, and the test proves a candidate cannot overwrite
  a same-route baseline artifact. `artifactNamespace: null` remains the
  no-write option.
- Replaced direct matrix writes with a same-directory UUID temp file created
  using `wx`, followed by `rename`. The temp file is removed in `finally` after
  a write or rename failure; an existing collision is not removed or
  overwritten. The filesystem operations are injectable for deterministic
  on-disk failure tests.

### TDD evidence

The new focused regressions were first run against the Round 0 implementation:

```bash
npm run test:unit -- tests/parity/http-baseline.test.ts tests/parity/http-compare.test.ts
```

The RED run had **29 pass / 5 fail**: captured HTML lacked
`bodyComparison`; candidate artifacts still resolved to
`.artifacts/http-baseline`; the comparator omitted `bodyComparison`,
`canonical`, `robots`, and `normalizedText`; semantic expected mode still
produced a hash diff; and the injected rename failure never reached a rename
operation because matrix persistence was a direct write.

After schema, extraction, comparator, namespace, and atomic-write changes, the
final focused suite was **36/36 pass**, including the real emitted-workerd
smoke. It covers ordered/multiple canonical and robots values, mixed attribute
case/order/quotes, entity normalization, script/style/comment exclusion,
semantic and exact comparison modes, suppressed-response no-read/no-leak
safety, candidate artifact isolation, and on-disk write/rename failure plus
temp-collision behavior.

### Regenerated baseline, privacy, and runtime evidence

`npx tsx scripts/capture-http-baseline.ts --write` regenerated the archive-only
source capture with:

```text
HTTP_BASELINE_WRITTEN 311 81
```

A genuinely fresh subsequent check passed:

```text
HTTP_BASELINE_OK 311 81
```

The baseline audit reports schema v2, 311 contracts, 81 deferred, 308 captured
(`exact`: 308; `semantic`: 0), 72 HTML semantic objects, three suppressed
private contracts, zero private body/semantic fields, zero non-HTML semantic
objects, and no missing comparison modes. The route matrix remains 122
`verified` and 149 `pending`, including the home/later-phase families; no
`.route-matrix-*.tmp` residue remains.

The real CLI smoke remained the generated Wrangler chain
`.wrangler/deploy/config.json -> dist/server/wrangler.json ->
dist/server/entry.mjs`, executes only through local workerd, and passed:

```text
HTTP_PARITY_OK scope=foundation contracts=225 verified=122 pending=149 ... disposed=true
```

### Round 1 verification and concerns

- Focused Task 4/5 tests: **36/36** pass.
- Full unit suite: **55/55** pass.
- `npm run format:check`, `npm run lint`, `npm run check`, and `npm run build`:
  pass. Astro reports 0 errors and 0 warnings; the repository's existing
  TypeScript-ESLint deprecation is a hint only.
- `npm run source:check`: `SOURCE_OK
  68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- `npm run parity:manifest -- --check`: `SOURCE_MANIFEST_OK 271`.
- `npm run parity:http -- --scope foundation`: pass with the counts above.
- `git diff --check` and final source/worktree status are repeated immediately
  before the Round 1 commit.

No routing or workerd behavior changed in this round. No blocking concern
remains; as before, the local Wrangler `unstable_startWorker` API is pinned and
covered by the emitted-artifact smoke rather than trusted through a mock.

## Round 2 — semantic candidate mode and Unicode-safe raw-text scanning

### Review fixes delivered

- `runFoundationParity` now narrows every foundation contract to the captured
  discriminant before reading body fields, then passes the expected
  `bodyComparison` into the candidate capture. A semantic expected contract
  therefore captures semantically too: an intentionally different expected
  hash does not create a false mode or hash diff when its public HTML semantics
  match. The prior pure comparator mode-mismatch regression remains in place.
- Raw-text closing-tag discovery no longer calls `toLowerCase()` on an entire
  HTML document and then reuses its indices against the original. It instead
  compares ASCII code units case-insensitively at original-document offsets.
  This is length-preserving and prevents U+0130 (`İ`) expansion from skipping
  visible text or later `data-build` attributes after `script`/`style` content.
  Both `htmlSemantics` and `normalizeDataBuildAttributes` share the corrected
  scanner.
- The atomic matrix implementation (Round 1 H2), schema v2 baseline,
  routing/workerd entries, and route matrix were intentionally left unchanged.

### TDD evidence

New regressions were added before production changes and the focused command
was observed RED:

```bash
npm run test:unit -- tests/parity/http-baseline.test.ts tests/parity/http-compare.test.ts
```

It had **36 pass / 3 fail**. The injected candidate parity fixture returned
exactly `bodyComparison expected=semantic actual=exact` despite identical HTML
semantics and a deliberately different expected hash. With ten U+0130 code
points before a raw `<script>`, `htmlSemantics` produced
`İ… script tail`, omitting `later script text`; `normalizeHtml` left the first
following `data-build="2026-08-21T00:00:00Z"` unnormalized. The tests cover
both `script` and `style` paths.

After propagating the expected mode and replacing whole-document lowercasing
with the ASCII/original-offset matcher, the focused suite was **39/39 pass**,
including the emitted local-workerd smoke. The full unit suite was **58/58
pass**.

### Round 2 verification and concerns

- `npm run format:check`, `npm run lint`, `npm run check`, and `npm run build`:
  pass. Astro reports 0 errors and 0 warnings; the existing TypeScript-ESLint
  deprecation remains a hint only.
- `npm run source:check`: `SOURCE_OK
  68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- `npm run parity:manifest -- --check`: `SOURCE_MANIFEST_OK 271`.
- Fresh archive-only `npx tsx scripts/capture-http-baseline.ts --check`:
  `HTTP_BASELINE_OK 311 81`; no `--write` or baseline regeneration occurred.
- Real `npm run parity:http -- --scope foundation`: **225** contracts,
  **122 verified**, **149 pending**, and `disposed=true` through the generated
  Wrangler/workerd topology.

No blocking concern remains. The only reported diagnostic is the repository's
pre-existing TypeScript-ESLint deprecation hint.
