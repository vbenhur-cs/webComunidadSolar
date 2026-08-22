# Phase 2 — Task 7 report

## Scope and preflight

- Base checked before changes: `a2215c308638acd4edf552a1eb5a5e8310cfdea3`.
- The worktree was clean and `npm run source:check` reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean` before work.
- The complete Task 7 plan and pinned immutable source ranges were read through
  `readSourceBlob`. No target runtime, test, build, or product source reads the
  sibling checkout, and it was not written or built.
- Scope is exactly `/soy-comunero`, `/contacto`, `/rentabiliza-tu-activo`, and
  `/comunidades-energeticas-operativas`; their shared page registry entries,
  one focused island, E2E evidence, and only their four route-matrix rows.
  Task 8 sitemap/legal work remains outside scope.

## TDD and implementation

1. The first prescribed E2E was RED: `/comunidades-energeticas-operativas`
   returned `404` where the test expected `200`. The native Astro route,
   registry entries, static prerender paths, and the four exact source ports
   make the route and interaction suite GREEN.
2. `OperationalPlantForm` is the sole Task 7 interactive component and is
   mounted `client:visible` in the visible hero. Its SSR control is an exact
   source-faithful anchor, not a fabricated button. It intercepts both the hero
   and later source anchors, supports a direct `#formulario-planta` URL, and
   adds the external iframe only after one of those explicit intents. There is
   no page-wide React root or iframe in the initial response.
3. The plan snippet called for a button named “estudiar mi planta”, but the
   pinned source renders `ButtonLink` anchors named exactly `Analizar el encaje
   de mi planta` and `Analizar mi planta`. The factual E2E uses the visible
   source anchor rather than changing source DOM semantics to fit the snippet.
4. Strict visual diagnosis found source React SSR emits a comment-plus-space
   boundary before the privacy anchors. A DOM RED exposed the missing space in
   the formatted Astro result. The minimal `Fragment` plus explicit whitespace
   GREEN preserves `nuestra<!-- --> <a` on both owner routes; no mask,
   normalization, or pixel tolerance was used.
5. A final SEO RED found all four pages inherited the generic title and
   description. The registry now carries the exact title/description pairs from
   the pinned source; focused browser assertions cover `<title>` and the
   description meta tag for all four paths.
6. Matrix promotion was performed only after all 12 strict captures were zero.
   Exactly four rows changed `pending -> verified`:
   `/soy-comunero`, `/contacto`, `/rentabiliza-tu-activo`, and
   `/comunidades-energeticas-operativas`. The emitted Worker count was first
   RED with `180 !== 176`; only its expected totals then changed to
   `180 verified / 91 pending` and became GREEN.

## Visual evidence

Final strict post-format command:

```text
npm run parity:visual -- --routes /soy-comunero,/contacto,/rentabiliza-tu-activo,/comunidades-energeticas-operativas
VISUAL_PARITY_MATCHED scope=foundation routes=4 results=12 pending=0 review_required=0 artifacts=.artifacts/visual
```

All 12 captures are `matched`: each selected page at desktop `1440x900`, tablet
`768x1024`, and mobile `390x844` has `differentPixels: 0`, no geometry
difference, no missing selector, and no dimension mismatch. Matrix promotion
occurred only after this evidence.

## Verification

- Focused Task 7 E2E: PASS (`4/4`): deferred iframe, direct hash intent, both
  React text boundaries, and exact SEO metadata.
- Full E2E suite: PASS (`16/16`).
- `npm run build`: PASS; all four Task 7 paths are prerendered.
- Full unit suite: PASS (`152/152`), including the real emitted Worker topology
  at `180/91`.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS with only three informational hints: the two existing
  hints in `eslint.config.js` and `scripts/lib/visual-contract.ts`, plus the
  source-faithful deprecated iframe `scrolling` attribute.
- `npm run parity:manifest`: PASS — `SOURCE_MANIFEST_OK 271`.
- `npm run source:check`: PASS after the gates — pinned source is clean.
- Strict visual capture: PASS with the literal result above.
- Focused Task 7 HTTP availability: PASS (`3/3`) for `/contacto`,
  `/rentabiliza-tu-activo`, and `/comunidades-energeticas-operativas`.
  The complete operating-plant contract is otherwise reached but stops at its
  `/sitemap.xml` assertion because that route is still `404`; sitemap is
  explicitly Task 8 and was not stubbed or implemented early.
- Staged autonomous verification: PASS. The isolated staged archive completed
  install, `check`, all `152/152` unit tests, and `build` without `.git` or a
  sibling source checkout. Post-commit verification is recorded after commit.

## Self-review and boundaries

- `git diff --check` is clean. Parsed base-to-worktree matrix comparison proves
  that only the four Task 7 paths changed status.
- Product/runtime sources contain no Next, Vinext, `server-only`, source
  checkout dependency, page-wide React island, routing alteration, baseline
  edit, or Task 8 implementation.
- The post-gate process audit found no Task 7 archive, candidate Worker,
  Chromium, or preview process. The pre-existing sibling source process group
  `49166` was intentionally left intact.
- The source-vs-plan CTA wording conflict and the explicit Task 8 sitemap
  boundary are the only concerns. They remain observable rather than being
  normalized or worked around.

## Commit

`feat: port member contact and owner routes` (SHA recorded after staged and
post-commit autonomous verification).
