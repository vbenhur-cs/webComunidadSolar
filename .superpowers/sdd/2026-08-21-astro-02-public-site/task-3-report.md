# Phase 2 — Task 3 report

## Scope and preflight

- Base checked before changes: `a801c14cd9250c4cbc6663797239f5111a2578c9`.
- The worktree was clean and `npm run source:check` reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Read the complete Task 3 plan/source ranges and used the pinned immutable
  source blobs for the home conversion. No source checkout was written, built,
  installed or used by target build/test/runtime.
- Scope is the public home, reusable small Astro components, the complete
  `CoverageFinder` React component, one home E2E, visual proof, and the one
  resulting matrix status. It does not create routes reserved for Tasks 4–8.

## TDD and implementation

1. The prescribed home HTTP and E2E checks were introduced/run before the
   implementation. The initial home had no source hero or coverage section;
   the prescribed map-button interaction was therefore RED.
2. Source inspection established a plan conflict: the exact home source renders
   `<CoverageFinder compact />`, whose compact branch has no map/community
   buttons. Parent direction prioritized the source blob and zero visual
   parity. The E2E consequently validates the real compact journey:
   `#cobertura`, its three steps, keyboard focus and the exact Helios URL.
   `CoverageFinder.tsx` still contains the complete reusable interactive map
   component for later routes, while the home renders its compact server output
   without hydration.
3. Ported the source home ranges mechanically into `HomeHero`, `HomeMap`,
   `TrustBand`, `PressTrustBand`, `HumanHelp`, `CustomerProof` and `HomePage`.
   `HumanHelp` includes both the full home branch and the planned
   `compact`/`general|commercializer` branch needed by Task 4.
4. The first focused home contracts became GREEN. A target-only compatibility
   correction placed `href` before `className` on the Header CTA so React SSR
   retains the frozen attribute order expected by the existing contract.
5. First strict visual evidence was RED despite exact geometry/dimensions:
   desktop `100`, tablet `538`, mobile `237` raw RGBA pixels. The clusters were
   only on dynamic press/post metadata and review-quote glyph boundaries.
   Read-only comparison showed React SSR emits text-node delimiters such as
   `Televisión<!-- --> · <!-- -->Agosto 2023`, whereas Astro had fused those
   nodes. A new focused HTML regression covering the six metadata boundaries
   plus the three dynamic quotes was RED.
6. GREEN preserves only those React text boundaries using constant
   `Fragment set:html="<!-- -->"` delimiters; dynamic values remain ordinary
   escaped Astro expressions. The exact source static dots are untouched.
   The focused delimiter test and build passed.
7. Once all three captures had zero raw differences, the `/` row in
   `parity/route-matrix.json` changed from `pending` to `verified`. That made
   the real Worker topology test correctly RED at `122 !== 123`; the updated
   matrix totals (`123` verified / `148` pending) are now asserted and GREEN.

## Visual evidence

- Initial diagnosis capture: dimensions and geometry exact, no missing
  selectors, but raw differences `100 / 538 / 237` for desktop/tablet/mobile.
- Final strict capture after formatting:
  `VISUAL_PARITY_MATCHED scope=foundation routes=1 results=3 pending=0 review_required=0 artifacts=.artifacts/visual`.
- Every viewport is exact: desktop `1440`, tablet `768`, mobile `390` wide;
  `differentPixels: 0`, `geometryDiffs: []`, no dimension mismatch, no missing
  selector, and no diff PNG for all three.
- The matrix update was made only after that zero-difference evidence.

## Verification

- Focused home HTTP contracts: PASS (4/4): hero/header, sourced trust,
  Villalbilla proof and home ordering.
- Compact CoverageFinder keyboard/Helios E2E: PASS (1/1).
- React text-boundary regression: RED then PASS.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS with the two existing informational hints in
  `eslint.config.js` and `scripts/lib/visual-contract.ts`.
- `npm run build`: PASS with those same hints.
- Full `npm test`: PASS (144/144), including the emitted Worker topology and
  the strict visual-harness unit suite.
- `npm run parity:visual -- --scope foundation`: PASS with the literal
  `VISUAL_PARITY_MATCHED` result above.
- `npm run verify:independent -- --staged`: PASS — `INDEPENDENT_OK
  source=staged tree=0a494eb350f5dd1502cc5fb3dac6ccec8f5a13b8 commands=4`, after
  `npm ci`, check, all 144 tests and build in an archive without `.git` or a
  sibling source checkout.
- The broad `npm run test:http` was deliberately run for visibility and has
  25 passing / 57 failing contracts, all for phase-reserved routes not created
  by Task 3. The prescribed Task 3 selection has the four known cross-task
  failures only:
  - `renders one native aerothermal page based on home study` and `publishes
    three native home-energy pages in sitemap` — Task 4;
  - `launches Helios coverage calculator with a coherent journey` — Task 5;
  - `does not promote subsidies as a service` because its later `/nosotros` or
    `/contacto` checks belong to Task 8.
  No stubs or routing changes were introduced to suppress those failures.

## Self-review and boundaries

- `git diff --check` is clean.
- The built home has exactly two islands, HeaderIsland and ConsentManager;
  `CoverageFinder compact` is not an island and there is no page-wide React
  root. Its complete map implementation remains available as the only allowed
  future interactive island.
- Target product files contain no Next/Vinext/server-only dependency. No
  page, source baseline, source sibling, or routing worker was changed.
- The visual runner completed with no owned source archive, candidate worker,
  preview, browser or temporary process remaining; a post-capture source guard
  is clean.

## Commit

`feat: reproduce the public home in Astro` (SHA reported after staged
autonomous verification and post-commit source guard).
