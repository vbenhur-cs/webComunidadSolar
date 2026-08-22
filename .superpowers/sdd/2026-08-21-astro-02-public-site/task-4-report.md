# Phase 2 — Task 4 report

## Scope and preflight

- Base checked before changes: `0b5c894d5ac555367f2cf05ef8fb382af159bc5b`.
- The worktree was clean and `npm run source:check` reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Read the complete Task 4 plan and the pinned immutable source ranges through
  `readSourceBlob`; no target command read, built, installed, or wrote the
  sibling source checkout.
- Scope is only the five home-energy pages, their reusable Astro primitives,
  static slug routing/metadata, the exact-route visual CLI prerequisite, one
  product E2E, and five resulting matrix rows. No Task 5 route, placeholder,
  baseline, source blob, or Worker routing behavior was added or changed.

## TDD and implementation

1. The prescribed focused HTTP selection was RED before the implementation:
   all five product pages returned `404` because `[slug].astro` did not exist.
2. The visual plan required `--routes`, while the existing strict harness only
   selected `--scope foundation`. A focused CLI/selection test was RED because
   `parseVisualArguments` was not exported. The minimal GREEN adds fail-closed
   exact matrix-path selection, rejects ambiguous/unknown/duplicate routes,
   and preserves the existing foundation mode.
3. Source review revealed a real plan conflict: `TariffBillSimulator` is
   retained as commented internal reference in `site.tsx`, while the rendered
   source page uses the static `TariffBillExample`. The frozen contract also
   requires `data-bill-example=true` and absence of `data-bill-simulator`.
   Source DOM/visual parity therefore wins: the new E2E is RED/GREEN for the
   static example, no range input and no page-wide React island. No simulator
   stub or dead component was created.
4. Ported the exact source ranges to native Astro page components and shared
   `ProductVisuals`, `FactStrip`, `FaqList`, `Steps`, product-card and advisor
   primitives. `[slug].astro` prerenders only the five implemented entries,
   renders exact page metadata, and retains the narrow legacy fallback.
5. The first product build rendered `/slug/index.html`; the generated asset
   runtime redirected bare URLs with `307`. A focused HTTP diagnosis established
   that `trailingSlash: "never"` alone does not control Astro directory output.
   `build.format: "file"` makes the five exact `*.html` outputs and restores
   direct `200` at the requested non-trailing-slash URLs. The focused HTTP
   contracts then passed `8/8`.
6. The first real visual invocation failed fail-closed because
   `generic-page` had no structural selector declaration. A selector-declaration
   regression was RED, then GREEN with the same body/header/main/footer geometry
   contract used for the generic source template; no capture masking or pixel
   normalization was added.
7. First permissive capture produced raw `differentPixels: 0` and zero geometry
   diffs for every requested viewport. Only after that evidence, the five exact
   matrix rows changed `pending -> verified`. The emitted Worker topology test
   then correctly became RED at `128 !== 123`; it is GREEN with the real matrix
   totals `128 verified / 143 pending`.

## Visual evidence

- Strict command, rerun after formatting:

  ```text
  npm run parity:visual -- --routes /autoconsumo-en-mi-tejado,/baterias,/aerotermia,/mantenimiento,/comercializadora-y-tarifas
  VISUAL_PARITY_MATCHED scope=foundation routes=5 results=15 pending=0 review_required=0 artifacts=.artifacts/visual
  ```

- Every route at desktop `1440x900`, tablet `768x1024`, and mobile `390x844`
  is `matched` with `differentPixels: 0`, `geometryDiffs: 0`, no missing
  selector, no dimension mismatch, and no diff PNG.
- The five and only five promoted rows are `/autoconsumo-en-mi-tejado`,
  `/baterias`, `/aerotermia`, `/mantenimiento`, and
  `/comercializadora-y-tarifas`.

## Verification

- Focused visual CLI/unit regressions: PASS (`14/14` under the focal runner).
- Focused HTTP product contracts: PASS (`8/8`).
- Static-commercializer E2E: PASS (`1/1`); full current E2E suite: PASS
  (`3/3`).
- Strict five-route visual capture: PASS, literal result above.
- Matrix cardinality RED: `128 !== 123`; exact expectation update then emitted
  Worker topology GREEN (`14/14`).
- Full unit suite: PASS (`145/145`).
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS with the two pre-existing informational hints in
  `eslint.config.js` and `scripts/lib/visual-contract.ts`.
- `npm run build`: PASS; all five product paths are prerendered as file-format
  outputs.
- `npm run parity:manifest`: PASS — `SOURCE_MANIFEST_OK 271`.
- `npm run parity:http`: PASS — `HTTP_PARITY_OK scope=foundation contracts=225
  verified=128 pending=143 ... disposed=true` against the emitted Worker.
- `npm run verify:independent -- --staged`: PASS — `INDEPENDENT_OK
  source=staged tree=71bef2ffda685fd3fa5ff33f5bc0bb5f63319d1e commands=4` after
  install, check, all 145 unit tests and build in a source-free archive.
- Broad `npm run test:http` was intentionally run as a phase-boundary audit:
  `31/82` pass and `51` fail only for pages, server behavior and sitemap work
  explicitly reserved for Tasks 5–8. The eight Task 4 product assertions are
  green. No stubs/routing changes were used to turn future-task failures green.
- Post-commit autonomous verification, final source guard, process audit, and
  clean worktree are recorded after commit below.

## Self-review and boundaries

- `git diff --check` is clean; the changed matrix diff contains only the five
  verified page statuses.
- Product files contain no `next`, `vinext`, `server-only`, source-checkout
  import, `client:` directive, or page-wide React island. Header and consent
  remain the shell islands; the commercializer main contains none.
- The visual/HTTP/E2E processes completed without an owned browser, worker,
  preview, archive or temporary build process remaining.
- The only task-plan conflict is the non-rendered tariff simulator described
  above; it is resolved in favor of the actual pinned source and visual/contract
  evidence.

## Commit

`feat: port home energy product routes to Astro` (SHA recorded after staged
autonomous verification and a final post-commit check).
