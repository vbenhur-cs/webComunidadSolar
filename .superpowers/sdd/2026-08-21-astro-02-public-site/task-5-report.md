# Phase 2 — Task 5 report

## Scope and preflight

- Base checked before changes: `4f70dba1ab5ca27e430c97d89bd0da158b13f38c`.
- The worktree was clean and the source guard reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Read the full Task 5 plan and the immutable pinned source ranges through
  `readSourceBlob`; no runtime, test, build, or production code reads the
  sibling checkout.
- Scope is the catalogue, exactly 21 published community detail paths, DTO-only
  coverage map hydration, source metadata, visual selector declaration, and the
  22 corresponding matrix rows. Manganafer remains pending and untouched.

## TDD and implementation

1. The first paths/selector RED was the missing community template module; the
   prescribed HTTP subset was then RED because the catalogue/detail URLs were
   `404`. The native Astro catalogue and dynamic prerendered detail route are
   GREEN for all 21 source slugs.
2. `selectCommunityTemplate` preserves the source wrapper exactly:
   `network` selects `NetworkCommunity`, every other published current record
   selects `LocalCommunity`. The source-defined `LegacyCommunity` is ported and
   statically covered but is selected by zero of the current 21 routes; no
   fictional editorial fallback or forced legacy route was added.
3. A DTO RED proved that only `slug`, `name`, `province`, `status`, `summary`,
   `map`, and `commercialStatus` may cross to the coverage island. The follow-up
   guard found the full frozen `communities` module still entering the client
   bundle as a default. GREEN makes the Community import type-only, passes
   `communities.map(communityCoverageDto)` only to the catalogue island, and
   splits static compact rendering from the hook-owning map component.
4. The initial strict visual capture isolated text-shaping deltas rather than
   CSS/geometry: the catalogue omitted one literal space after the scale-note
   `<strong>`, and detail ports omitted React SSR comment boundaries around
   dynamic values. Focused HTML/E2E REDs reproduce those boundaries; the
   minimal comments restore exact text nodes for local units and all ten network
   location labels.
5. An SEO RED proved that dynamic community pages retained the global social
   image. `SiteMeta.socialImage` is now an optional exact override; the detail
   route emits its source community image/alt for OG and Twitter while other
   pages retain the default.
6. Matrix promotion happened only after catalogue + all 21 detail HTTP/E2E
   evidence and strict representative captures. Exactly 22 rows changed
   `pending -> verified`, yielding `150 verified / 121 pending`. The emitted
   Worker count test was intentionally RED at `150 !== 128`, then GREEN with
   the real totals.

## Visual evidence

The final strict command (rerun after DTO/Legacy review changes and formatting)
was:

```text
npm run parity:visual -- --routes /comunidades-energeticas,/comunidades-energeticas/villalbilla,/comunidades-energeticas/extremadura,/comunidades-energeticas/ontinyent
VISUAL_PARITY_MATCHED scope=foundation routes=4 results=12 pending=0 review_required=0 artifacts=.artifacts/visual
```

All 12 captures—desktop `1440x900`, tablet `768x1024`, and mobile `390x844`
for catalogue, Villalbilla, Extremeña, and Ontinyent—report
`differentPixels: 0`, zero geometry differences, no missing selector and no
dimension mismatch. The matrix does not promote Manganafer.

## Verification

- Focused source-template/DTO/legacy unit regressions: PASS.
- `npm run build`: PASS; all 21 dynamic paths are prerendered.
- `npm run test:e2e -- tests/e2e/communities.spec.ts`: PASS (`4/4`), including
  catalogue plus all 21 detail responses, SSR boundaries and per-page social
  image metadata.
- Task 5 HTTP subset: 11 relevant catalogue/detail contracts PASS. The only 6
  failures are `/sitemap.xml` `404` assertions (Ontinyent/Escurial, Robregordo,
  Extremeña locations, duplicate slugs, and local images), which belong to the
  Task 8 sitemap implementation. No route, stub, or sitemap was added early.
- Full unit suite: PASS (`150/150`), including the emitted Worker topology at
  `150 verified / 121 pending`.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS with the two pre-existing informational hints in
  `eslint.config.js` and `scripts/lib/visual-contract.ts`.
- `npm run parity:manifest`: PASS — `SOURCE_MANIFEST_OK 271`.
- Staged autonomous verification: PASS —
  `INDEPENDENT_OK source=staged tree=5dc9992a96069cf2b9591c9f898727405d675883 commands=4`.
  Its isolated archive completed `check`, all `150/150` unit tests, and build.
- Final source guard, post-commit autonomous verification, process audit, and
  clean status are recorded after commit.

## Self-review and boundaries

- `git diff --check` is clean; `parity/route-matrix.json` changes only the
  catalogue plus the 21 published community paths.
- No `next`, `vinext`, `server-only`, source-checkout dependency, page-wide
  React island, new route, routing change, baseline edit, or Manganafer source
  was introduced.
- The only source/plan tension is the requested legacy branch: the pinned
  wrapper has exactly two live outcomes today. The isolated legacy source
  component remains present and covered without changing that runtime decision.
- Task 8 owns sitemap generation; its six known HTTP failures remain explicit
  rather than being hidden by premature implementation.
- Process audit found a pre-existing, non-attributable sibling source dev group
  (PGID `49166`; PIDs `49166`, `49212`, and `49223`, born 2026-08-20 20:05).
  It was intentionally left intact. No Task 5 archive, preview, Chromium, or
  candidate process remained after the gates.

## Commit

`feat: port all energy community routes` (SHA recorded after staged and
post-commit autonomous verification).
