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

## Round 2 — review remediation

This round was applied on top of the initial Task 6 harness. It changes only
the visual-harness scripts and their focused contract tests; it does not alter
pages, CSS, baselines, routing, or `parity/route-matrix.json`.

### TDD record

Each review item was added as a failing focused test before its production
change, then rerun GREEN before moving to the next item.

1. **Strict raw pixels and dimensions.** The RED image contains four one-channel
   RGBA deltas, including `[48,48,48,0]` versus `[48,48,48,1]`, a transparent
   RGB delta, and an edge delta. The former `pixelmatch` count was `2` where
   the test required `4`. GREEN keeps `pixelmatch` only for rendering and makes
   a direct raw-RGBA scan authoritative, painting every raw-different pixel
   opaque red in a same-dimension diff PNG. A separate RED/GREEN uses 2x3 and
   3x2 images: four non-overlap coordinates plus one raw overlap delta now
   report `differentPixels=5`, `diffRatio=0.625`, and no diff PNG. Thus a
   dimension mismatch no longer fabricates the maximum canvas area as its
   difference count.
2. **Network fail-closed after capture.** The RED double invokes an undeclared
   `https://late.example.test/close.js` route while `context.close()` is in
   progress; the old behavior resolved capture (`Missing expected rejection`).
   GREEN retains the first external-request `Error`, verifies it after a
   successful close, and preserves the full URL. The current focused test
   rejects with `Solicitud externa sin fixture visual:
   https://late.example.test/close.js`.
3. **Bounded lifecycle and child process cleanup.** REDs cover a late
   `newContext()` resolution, a hanging context close, a hanging candidate
   `worker.ready`, a hanging browser close while outer resources still close,
   and preservation of a primary navigation/capture failure when cleanup also
   expires. GREEN attaches bounded late cleanup to resources acquired after a
   deadline; context, browser, worker, bridge readiness/disposal, report
   writing, source guards, and loopback server close have actionable lifecycle
   deadlines. The primary error remains the thrown error and a cleanup failure
   is retained as its cause where possible. The candidate build has an
   independent 120 s deadline and bounded detached process-group termination.
   Its RED launches a leader that exits on `SIGTERM` and a descendant that
   ignores it; GREEN always follows with group `SIGKILL`, proving neither the
   descendant marker nor its PID survives.
4. **Missing selectors.** The RED supplied every declared selector as missing
   on both sides and was previously matched. GREEN serializes separately
   sorted reference/candidate lists, retains them in JSON/HTML evidence, and
   makes either list review-required. The deterministic assertion is
   `{"reference":["footer","header"],"candidate":["footer","header"]}`.
5. **Archive-only assets.** The existing regular `dist/client/assets` GET/HEAD
   test remains green with exact bytes and MIME and without a Worker call.
   The new RED puts an external directory behind `dist/public` and initially
   failed with `Missing expected rejection`. GREEN uses `lstat` and `realpath`
   for the archive root, candidate parent, and file before `readFile`; any
   parent/file target outside the real archive root hard-fails before bytes are
   read. Lexical traversal checks and worker delegation for absent paths and
   `/` remain intact.
6. **Artifact and fixture audits.** A two-write RED showed that a later
   no-diff run left that route/viewport's old `diff.png`. GREEN removes only
   the contained sibling `diff.png` when the later result has no diff buffer.
   The fixture parser REDs for `%%%` and non-canonical `AA`, both of which
   previously decoded silently; GREEN requires canonical standard Base64 while
   accepting an explicit empty string as a zero-byte body.

The final focused command passed all 31 tests:

```text
npm run test:unit -- tests/parity/visual-contract.test.ts
# tests 31
# pass 31
# fail 0
```

### Round 2 full verification

All gates were rerun after the final GREEN, followed by a real smoke without
external intervention:

```text
npx playwright install chromium                       # exit 0
npm test                                              # 89/89 pass, 13.02 s
npm run format:check                                  # exit 0
npm run lint                                          # exit 0
npm run check                                         # 0 errors, 0 warnings, 2 hints
npm run build                                         # exit 0
npm run parity:manifest -- --check                    # SOURCE_MANIFEST_OK 271
npx tsx scripts/capture-http-baseline.ts --check      # HTTP_BASELINE_OK 311 81
npm run parity:http -- --scope foundation             # HTTP_PARITY_OK contracts=225 verified=122 pending=149 disposed=true
npm run parity:visual -- --scope foundation --allow-pending
# VISUAL_PARITY_PENDING scope=foundation routes=1 results=3 pending=3 review_required=0
# real 71.39
npm run source:check                                  # SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
git diff --check                                      # exit 0
```

The real smoke's summary records exactly one route and three pending results.
Both screenshot sides decode at the fixed viewport widths `1440`, `768`, and
`390`. The reference screenshots remain the real styled archive page (all
declared reference selectors present; visibly rendered stylesheet/layout),
while the intentionally unimplemented foundation home candidate retains its
round-one evidence: heights `900/1024/844`, missing structural selectors, and
pixel/geometry/dimension differences. Those differences are pending evidence,
not a visual-parity assertion. No `diff.png` exists for this pending-only
smoke.

The route-matrix hash is unchanged both immediately before and after the smoke:

```text
5ca79957e6c307f64c96cadfa36782f7c426129a1dddaca35c942bcb12f7de7f  parity/route-matrix.json
```

The post-smoke audit found no `comunidadsolar-source-build-*`,
`visual-command-timeout-*`, fixture, stale-diff, or asset-escape temporary
directory; no harness-attributable PID/PGID remained; and no stale artifact
diff was present. The only observed running `workerd` is the pre-existing,
unrelated Vite process in sibling `comunidadsolarweb`, so it was not touched.

The two non-blocking check hints are unchanged in kind: the pre-existing
deprecated `tseslint.config` signature in `eslint.config.js:6:25`, and the
new TypeScript suggestion at `scripts/lib/visual-contract.ts:748:10` that
`captureGeometry` could be `async`. They are hints, not errors/warnings; the
latter remains a deliberate promise-combinator shape.

### Round 2 self-review

- Raw channel equality, not `pixelmatch`, is authoritative for the reported
  same-dimension count; every raw delta is visible in its diff artifact.
- Mismatched dimensions use a coordinate-union count, never an invented
  maximum-area count, and intentionally have no diff PNG.
- Error-preserving bounded cleanup covers acquired-late resources as well as
  normal close paths; the actual child-process test proves the descendant
  cannot outlive a timeout even when its leader exits first.
- Archive serving verifies real filesystem containment before any read and
  still delegates non-assets to the Worker; no source archive is mutated.
- The only current worktree changes are the two harness files and their test;
  ignored smoke artifacts were audited but not deleted.

## Round 3 — lifecycle, source, and artifact re-review

Round 3 remediates the five Important review findings without changing pages,
CSS, baselines, routing, or the route matrix. It also preserves all Round 2
raw-pixel, missing-selector, Base64, and stale-diff behavior.

### TDD record

Every new behavioral change was first reproduced by a focused injected test.

1. **External request plus failed close.** The new close double emits an
   undeclared `https://late.example.test/close-failure.js` request and then
   throws `close root failure`. GREEN makes the external URL the actionable
   failure and retains the close failure as its cause rather than allowing
   cleanup to hide a fail-closed network violation.
2. **Archive and artifact symlink boundaries.** The source-root fixture now
   points a lexical archive root at a genuinely external directory. Report
   fixtures cover an external `.artifacts` parent, `.artifacts/visual`, a
   route component, a final PNG, `summary.json`, and a stale `diff.png`.
   All reject before an external target is read, written, or removed. Archive
   reads use `O_NOFOLLOW`, `fstat`, inode/realpath containment revalidation,
   and document the private immutable-archive trust boundary: Node has no
   `openat`/directory-FD primitive that could promise to defeat an adversarial
   parent rename.
3. **Source callback and real npm preparation deadline.** The callback-admit
   RED failed with:

   ```text
   El ciclo de vida visual superó 5 ms durante preparar el build fuente temporal
   ```

   while a callback already owned candidate/reference/browser cleanup. GREEN
   cancels that admission timer as soon as the callback starts. A separate
   real Task 4 process-group RED initially returned:

   ```text
   timeout --signal=TERM --kill-after=30ms 500ms npm run build terminó con código 124
   ```

   GREEN adds `deadlineMs`, a shared npm-preparation budget consumed by
   `withTemporarySourceBuild`. It rejects only after the bounded npm process
   group has exited and the helper finally has removed its archive; the test
   observes `El presupuesto de procesos npm del archive temporal superó 500 ms`,
   the parent TERM marker, absent descendant PID/marker, and no temporary
   session. The budget deliberately gates npm stages only; archive/git/tar
   setup may finish before the expiry is observed, and is documented as such.
   For an injected runner with no cancellation contract, the deadline only
   guarantees no late callback/candidate starts; the never-resolving fake is
   kept as a separate test.
4. **Forced cleanup completes before orchestration returns.** The browser and
   candidate REDs both ended `false !== true`: `runVisualParity` had returned
   while the BrowserServer kill or Wrangler raw teardown was still pending.
   GREEN partitions a cleanup budget with reserved slack across close/kill and
   bridge/dispose/raw-teardown phases, and gives the outer resource wrapper the
   same total budget. The injected tests prove the force operation has finished
   before the rejected orchestration promise returns. Existing error chains
   retain close/dispose as the primary failure and kill/teardown as causes.
5. **Browser, Worker, and Windows hard-stop paths.** Chromium uses
   `launchServer` plus `connect`, closes the BrowserServer with bounded
   `close`, and invokes bounded `kill` as a fallback. A late server and both a
   failed and a late `connect` are killed. Candidate Worker disposal falls back
   to supported `raw.teardown()` after a failed/expired `dispose`. The command
   runner now fails before spawning on Windows, instead of pretending that a
   single `child.kill()` can terminate a process tree. The candidate build and
   temporary-source test both prove TERM-resistant descendants receive SIGKILL.

Focused Task 4 + Task 6 verification after the last GREEN:

```text
npm run test:unit -- tests/parity/http-baseline.test.ts tests/parity/visual-contract.test.ts
# tests 74
# pass 74
# fail 0
```

### Round 3 final verification

The full gates were rerun after the final GREEN:

```text
npx playwright install chromium                       # exit 0
npm test                                              # 107/107 pass
npm run format:check                                  # exit 0
npm run lint                                          # exit 0
npm run check                                         # 0 errors, 0 warnings, 2 hints
npm run build                                         # exit 0
npm run parity:manifest -- --check                    # SOURCE_MANIFEST_OK 271
npx tsx scripts/capture-http-baseline.ts --check      # exit 0
npm run parity:http -- --scope foundation             # HTTP_PARITY_OK contracts=225 verified=122 pending=149 disposed=true
npm run parity:visual -- --scope foundation --allow-pending
# exit 0, real 54.23 s
# VISUAL_PARITY_PENDING scope=foundation routes=1 results=3 pending=3 review_required=0 artifacts=.artifacts/visual
npm run source:check                                  # SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
git diff --check                                      # exit 0
```

The final smoke summary has one route and exactly three `pending` results;
`matched=0`, `reviewRequired=0`, and `pending=3`. Reference PNG widths are
exactly `1440`, `768`, and `390` at desktop/tablet/mobile. A direct visual
audit of the desktop reference confirms the real styled archive page and its
CSS-loaded layout. It retains pending evidence rather than a parity claim:

```text
desktop reference/candidate heights 13761/900, pixels 19815349, geometry 10
tablet  reference/candidate heights 17704/1024, pixels 13562589, geometry 10
mobile  reference/candidate heights 21009/844, pixels 8192390, geometry 10
```

The files are contained under `.artifacts/visual/foundation/root-home/`; no
`diff.png` is written for these dimension-mismatch comparisons, as required.
The matrix SHA-256 immediately before and after the final visual command is
unchanged:

```text
5ca79957e6c307f64c96cadfa36782f7c426129a1dddaca35c942bcb12f7de7f  parity/route-matrix.json
```

Post-smoke audit found no harness-attributable child/runtime/browser process,
no `comunidadsolar-source-build-*` session, and no lifecycle test marker/temp
directory. It did observe the pre-existing source-sibling Vite/workerd pair
(`49212`/`49223`, started 20 August, outside this harness); it was not touched.

### Round 3 self-review and concerns

- All five review findings are covered by deterministic RED/GREEN tests;
  source, artifact, network, BrowserServer, raw-teardown, process-group, and
  Windows paths preserve actionable primary errors and bounded cleanup.
- Raw RGBA equality remains authoritative, dimension mismatches retain their
  real union count without a fabricated diff PNG, and missing selectors remain
  visible in serialized evidence.
- The two check hints remain non-blocking: the pre-existing deprecated
  `tseslint.config` signature and the Task 6 `captureGeometry` async
  suggestion. Neither is an error or warning.
- The foundation home remains intentionally pending; its large real
  differences are evidence for a later migration phase, not a Task 6 defect.
- `deadlineMs` intentionally cannot preempt a hung archive/git/tar operation;
  it bounds the helper's npm preparation and waits for process-group/finally
  cleanup before returning. This explicit Node API limitation is documented
  rather than hidden by a premature outer `Promise.race`.
