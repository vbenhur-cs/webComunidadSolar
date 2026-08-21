# Task 6 report — strict visual and geometry parity harness

## Preflight

- Worktree: `comunidadsolar-astro/.worktrees/astro-full-migration`
- Candidate base: `11149741d9afc50cc9000f834667fed0e568d364`
  (`1114974 fix: preserve HTTP semantic capture mode`)
- Candidate worktree was clean before Task 6.
- `npm run source:check` before Task 6:

```text
SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
```

## TDD RED

The test suite was created before either production module. The required
focused command failed because the visual contract implementation did not yet
exist:

```text
> comunidad-solar-astro@0.1.0 test:unit
> tsx scripts/run-unit-tests.ts tests/parity/visual-contract.test.ts

TAP version 13
# node:internal/modules/esm/resolve:275
#     throw new ERR_MODULE_NOT_FOUND(
#           ^
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/vbenhur/Documents/Projects VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/scripts/lib/visual-contract.ts' imported from /Users/vbenhur/Documents/Projects VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/tests/parity/visual-contract.test.ts
#     at finalizeResolution (node:internal/modules/esm/resolve:275:11)
#     at moduleResolve (node:internal/modules/esm/resolve:861:10)
#     at defaultResolve (node:internal/modules/esm/resolve:985:11)
#     at #cachedDefaultResolve (node:internal/modules/esm/loader:747:20)
#     at resolveDirectorySync (file:///Users/vbenhur/Documents/Projects%20VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/node_modules/tsx/dist/register-C4vWVmug.mjs:2:12238)
#     at resolve (file:///Users/vbenhur/Documents/Projects%20VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/node_modules/tsx/dist/register-C4vWVmug.mjs:2:15991) {
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///Users/vbenhur/Documents/Projects%20VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/scripts/lib/visual-contract.ts'
# }
# Node.js v22.22.3
# Subtest: tests/parity/visual-contract.test.ts
not ok 1 - tests/parity/visual-contract.test.ts
  ---
  duration_ms: 157.044667
  type: 'test'
  location: '/Users/vbenhur/Documents/Projects VS/WebComunidadSolar/comunidadsolar-astro/.worktrees/astro-full-migration/tests/parity/visual-contract.test.ts:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 160.965958
```

The failure is the intended missing-implementation failure, before a browser,
fixture, source archive, candidate runtime, or screenshot is used.

## Focused GREEN

After implementing the contract and injectable orchestration boundary, the
same focused command passed:

```text
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1565.907083
```

The suite uses PNG buffers generated in memory and exercises the production
comparator. Its lifecycle doubles fail unless consent, network-idle, fonts,
images, full-page capture, fail-closed network routing, and `finally` cleanup
occur in the required order.

## Follow-up RED/GREEN regressions and diagnosis

The initial smoke exposed real integration problems which were diagnosed one at
a time. None was converted into a matched or verified result.

1. Playwright's default timeout did not bound `goto`, then image waits could
   remain pending. The capture now applies a navigation timeout plus a bounded
   deadline to every stage. The fonts regression proves that a timed-out stage
   closes the isolated context.
2. An image-stage RED failed with the actionable but incomplete message:

   ```text
   La captura visual superó 5 ms durante la carga de imágenes; url=http://127.0.0.1:40127/ viewport=desktop:1440x900
   ```

   The GREEN test requires `side=reference` and a bounded, escaped,
   deterministic `pendingImages=` JSON list containing `src`, `currentSrc`,
   `loading`, `complete`, and `naturalWidth`. It passed after the diagnostic
   was added (15/15 focused tests at that point).
3. The real reference then reported eight local images with
   `loading:"lazy", complete:false, naturalWidth:0`, not an external request
   or a broken fixture. The focused lazy-image RED was:

   ```text
   lazy image must be activated before waiting
   'lazy' !== 'eager'
   ```

   The minimum harness-only change assigns `HTMLImageElement.loading =
   "eager"` before registering `load`/`error` listeners. The test proves that
   `src` and `currentSrc` are unchanged and that no scroll, CSS, mask, or DOM
   structure is changed. It is applied symmetrically to reference and
   candidate.
4. A real Playwright smoke then found a closure hidden by the earlier doubles:

   ```text
   locator.evaluateAll: ReferenceError: selector is not defined
   ```

   A RED reconstructs the geometry page function in a VM without closures.
   The capture contract now accepts a serializable `evaluateAll` argument and
   passes each selector explicitly. The resulting focal suite was 17/17.
5. The first apparently successful smoke was rejected during artifact audit:
   its reference PNG was 6008 px wide at the desktop viewport and showed
   default body margins. Archive diagnosis found HTML emitting
   `/assets/index-B7W9r4T8.css`; the exact file existed at
   `dist/client/assets/index-B7W9r4T8.css` (387,821 bytes), but the built
   vinext Worker returned `404 text/plain;charset=UTF-8`, body `Not Found`,
   without calling `env.ASSETS.fetch`.

   A RED first failed because `dispatchSourceRuntimeRequest` and
   `sourceAssetFetcher` did not exist. Its fixture uses the exact
   `dist/client/assets` layout and requires GET/HEAD status, MIME, and bytes;
   it proves assets do not call the Worker and that an absent asset, a
   directory, and `/` do delegate to the Worker. The GREEN implementation
   dispatches regular archive files before the source Worker and delegates on
   a miss, preserving a real page 404. The final focused suite is 18/18.

Two early manually interrupted diagnostic runs left only their attributable
temporary archive directories after the parent process was terminated before
`finally`; both were verified by PID/PGID and moved recoverably to the local
Trash. All later smoke runs completed under their own deadlines and their
temporary archive/process cleanup was verified. No source checkout file was
written, built, started, or removed.

## Final real smoke and artifacts

Final command:

```text
npm run parity:visual -- --scope foundation --allow-pending
VISUAL_PARITY_PENDING scope=foundation routes=1 results=3 pending=3 review_required=0 artifacts=.artifacts/visual
```

It exited 0 only because `--allow-pending` was explicit. It records real
pixel/geometry evidence, not a home-parity claim:

- one route (`page:/`), exactly three fixed viewports, all three statuses
  `pending`;
- summary: `matched=0`, `reviewRequired=0`, `pending=3`;
- candidate is intentionally the foundation smoke, so the retained evidence
  includes dimension/geometry differences rather than a verified result;
- source/candidate screenshot widths were decoded after the final smoke and
  are exactly desktop `1440`, tablet `768`, mobile `390` for both sides;
- source heights were `13761`, `17704`, `21009`; candidate smoke heights were
  `900`, `1024`, `844` respectively;
- the corrected source geometry has `body` x/y `0/0` and width equal to the
  viewport, while the unstyled candidate smoke keeps default body margins,
  corroborating that the source CSS was loaded rather than masked.

Artifacts remain ignored under `.artifacts/visual/foundation/`:

```text
root-home/desktop/reference.png
root-home/desktop/candidate.png
root-home/tablet/reference.png
root-home/tablet/candidate.png
root-home/mobile/reference.png
root-home/mobile/candidate.png
summary.json
summary.html
```

No third-party fixture was added: the observed failing resources were local
archive media and were resolved by deterministic lazy-load activation. The
network policy still rejects every undeclared external URL with that URL in the
error and serves declared fixtures byte-identically on both sides.

## Fresh final verification

All commands below were rerun after the source-asset correction (Chromium was
already installed, so its installer completed with exit 0 and no download):

```text
npm run source:check                                  # SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
npx playwright install chromium                       # exit 0
npm run test:unit -- tests/parity/visual-contract.test.ts  # 18/18 pass
npm test                                              # 76/76 pass
npm run format:check                                  # exit 0
npm run lint                                          # exit 0
npm run check                                         # exit 0, 0 errors
npm run build                                         # exit 0
npm run parity:manifest -- --check                    # SOURCE_MANIFEST_OK 271
npx tsx scripts/capture-http-baseline.ts --check      # HTTP_BASELINE_OK 311 81
npm run parity:http -- --scope foundation             # HTTP_PARITY_OK, contracts=225, verified=122, pending=149, disposed=true
npm run parity:visual -- --scope foundation --allow-pending  # exit 0, VISUAL_PARITY_PENDING
npm run source:check                                  # SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
```

`npm run check` and `npm run build` emit no errors. They emit two non-blocking
hints which were reviewed:

- pre-existing `eslint.config.js:6:25 ts(6387)`: the
  `tseslint.config` signature is deprecated;
- new `scripts/lib/visual-contract.ts:604:10 ts(80006)`: TypeScript suggests
  converting `captureGeometry` to `async`; it is intentionally a promise
  combinator and is not an error or warning.

The route matrix SHA-256 immediately before and after the final visual command
is identical:

```text
5ca79957e6c307f64c96cadfa36782f7c426129a1dddaca35c942bcb12f7de7f  parity/route-matrix.json
```

The final audit found no attributable temporary source-build directory, local
runtime, browser, or child process. A pre-existing source-sibling `workerd`
process (PID 49223, outside this harness) was observed but not touched. The
final source guard remained clean. `git diff --check` is recorded with the
staged final review below.

## Self-review

- Comparator uses strict RGBA `pixelmatch` (`threshold: 0`, `includeAA: true`),
  dimension validation, diff output for same-dimension pixel differences, and
  deterministic two-decimal geometry/presence diffs.
- Contexts use the required viewport/DPR/locale/light/reduced-motion/service
  worker settings; consent precedes navigation; waits cover network idle,
  fonts, lazy activation plus image load/error, full-page screenshot, and
  selector geometry with actionable deadlines.
- Reference runs only inside `withTemporarySourceBuild`; candidate runs the
  generated Wrangler deployment entry; both bridges bind loopback port 0 and
  close through `finally`.
- Artifact paths are checked as portable and contained; report HTML escapes
  values; no pages, CSS, baseline, routing, or route-matrix statuses changed.
- The deliberate concern remains: home is a pending smoke and visibly differs
  from the source. This harness records that evidence and does not call it
  matched or verified.
