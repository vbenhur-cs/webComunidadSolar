# Phase 2 — Task 8 report

## Scope and source boundary

- Base: `bda11048720a6c2acb187da4964c9419828e06a6`.
- The pinned source guard passed before and after implementation:
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- The source development process group `49166` was observed but left intact.
  No source checkout was written or used at target runtime.
- The master plan was not edited. The Task-8 asset requirement extends only
  the canonical checked-in `SourceManifest.assets` schema and tests with a
  deterministic `mediaType` next to `sha256` and `bytes`.

## Delivered behavior

- Added the four source-text legal pages, source-compatible `robots.txt`,
  deterministic sitemap, and source-compatible 404 route.
- Added a shared public-route closure policy. The sitemap intentionally keeps
  `/comunidades-energeticas/manganafer`; the only explicit Phase-3 deferment
  is reported by link verification, not turned into a stub or a 200 response.
- Added the bounded Worker-backed `verify:links` CLI. It checks links,
  fragments, manifest statuses, redirects, gone routes, and reports deferred
  routes without treating `//host` as an internal URL.
- Public HTML baseline generation now uses semantic comparison only for
  captured Phase-2 public HTML. XML, text, redirects, gone routes, private
  responses, deferred Manganáfer, and assets retain exact/deferred modes.
- Source manifest public assets are verified by response bytes, SHA-256, and
  `mediaType` before public HTTP parity can promote a matrix row.

## TDD and debugging evidence

1. The legal-template selector first failed with
   `No hay selectores visuales para template legal-page`; the selector was
   added and the strict capture became green.
2. React text-node boundaries were preserved rather than masked. The final
   Fuente Álamo mismatch was localized to two badge expressions and fixed with
   source-equivalent comment boundaries.
3. The source-live Villaverde/Getafe response contains `nextAction` solely as
   an RSC-serialized, non-visible community property. A public HTML semantics
   RED drove the general, nonvisual
   `data-community-next-action={community.nextAction}` attribute on the local
   detail container. It preserves published machine semantics without adding
   visible or hidden copy; strict visual recapture stayed zero-diff.
4. The frozen-contract preservation gate exposed an accidental regression:
   `711 !== 709` assertions after adding two `assert.deepEqual` checks to the
   frozen source contract. A focal RED required
   `requireExactPhase3DeferredPublicRoutes`; the green primitive validates the
   exact deferred list for both consumers while retaining all `709` original
   assertion calls and their fingerprint.
5. Prettier exposed Astro non-idempotence around a dynamic React comment
   boundary; extracting the suffix expression retained the exact boundary and
   made `format:check` green. ESLint rejected a control-character regex in the
   sitemap guard; a code-point predicate retained the security policy and made
   lint green.
6. Final review added a surplus-manifest-asset RED: public asset parity now
   requires a bijection between every manifest asset and a matrix asset row,
   with source status `200`, before it compares bytes, SHA-256, and media
   type.
7. Link review added real relative (`./`, `../`) and same-origin absolute URL
   cases, while retaining `//host` as external. Worker startup, readiness,
   fetch, and dispose/raw-teardown are bounded; a timeout after acquisition
   completes its bounded cleanup before returning. A late, uncancellable
   Wrangler startup is disposed as soon as it resolves.
8. Removed source-text change detectors for public HTML. The emitted E2E
   suite now proves the local-community machine attribute; emitted E2E, HTTP,
   and visual gates cover robots and 404 behavior.

## Verification

| Gate | Fresh result |
| --- | --- |
| `npm run format:check` | PASS |
| `npm run lint` | PASS |
| `npm run check` | PASS; 0 errors, 3 existing hints |
| `npm test` | PASS; 176/176 |
| `npm run build` | PASS |
| E2E SEO + general pages | PASS; 8/8 |
| `npm run verify:links` | `LINKS_OK checked=3340 deferred=1` |
| `npm run parity:manifest -- --check` | `SOURCE_MANIFEST_OK 271` |
| `npx tsx scripts/capture-http-baseline.ts --check` | `HTTP_BASELINE_OK 311 81` |
| `npm run test:http -- --scope public` | 65 pass, 0 fail, 17 server-only skips |
| `npm run parity:http -- --scope public` | `HTTP_PARITY_OK scope=public contracts=366 verified=263 pending=8 ... disposed=true` |
| strict public visual after formatting | `VISUAL_PARITY_MATCHED scope=public routes=62 results=186 pending=0 review_required=0` |
| `npm run verify:independent -- --staged` | `INDEPENDENT_OK source=staged tree=670caba17edee9b09dc609cad7d8624bdfd7cea2 commands=4` |

The three `astro check` hints are pre-existing/dependency/source-faithful:
the TypeScript ESLint config deprecation, an optional async suggestion in the
visual harness, and source-exact `scrolling="no"`.

## Matrix, self-review, and cleanup

- Matrix audit: `271` total, `263` `verified`, `8` `pending`.
- The exact pending set is the three Manganáfer APIs, Phase-3
  `/comunidades-energeticas/manganafer`, and four private routes
  (`/guia-equipo`, its Markdown, `/manganafer/interesados`, `/socios`).
- `git diff --check` is clean. Static review found no new checkout, Next,
  Vinext, or server-only runtime dependency; the only existing provenance
  constants and frozen content literals remain intentional.
- No owned Chromium, candidate Worker, preview, or archive process remained
  after the final visual/HTTP/E2E gates. The only observed workerd belonged to
  the pre-existing source PGID `49166` and was untouched.

## Remaining closeout

The product-only staged archive was verified before this ignored report was
added to the commit. The remaining closeout is the requested focused commit,
then the HEAD autonomy check and process/status audit.
