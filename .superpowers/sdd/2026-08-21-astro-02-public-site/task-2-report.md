# Phase 2 — Task 2 report

## Scope and preflight

- Base checked before changes: `26db0790f63419f612e9f8a2636b3c140d4096ab`.
- The worktree was clean and `npm run source:check` reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Read the Phase 2 plan, the migration constraints/specification and the Task 2
  source ranges before implementation. Source inspection used only the pinned
  immutable source commit; no source checkout is read at target build, test or
  runtime.
- Scope is limited to the native document shell, global islands, contract
  runner/helpers, the shell E2E and their supporting configuration. It does not
  begin the home or any later route migration.

## TDD and implementation

1. The prescribed HTTP subset was run before the shell existed. It failed
   because the canonical/social metadata and the cookie-settings control were
   absent.
2. Implemented `DocumentLayout` and `SiteLayout`, `HeaderIsland`, Astro footer
   and primitives, `ConsentManager`, metadata/page registry, preview pool and
   local migrated-source readers. `index.astro` is explicitly prerendered and
   uses the shell; only Header and Consent are client islands.
3. The focused HTTP subset is GREEN: canonical/social metadata and no analytics
   before consent pass against a locally owned preview.
4. Review-driven RED/GREEN coverage additionally proves:
   - `requestPreview()` uses `redirect: "manual"`; the 308/Location contract is
     observable rather than followed.
   - migrated bundles have lexical ordering and project assets reject an
     intermediate symlink escape;
   - an explicit `description: null` remains distinct from an omitted
     description;
   - a rejected preview startup does not make `pool.close()` fail after the
     originating request has reported its error;
   - the exit listener is armed before TERM, a live descendant is killed with
     its POSIX process group, and a group is also killed when its leader has
     already exited. The latter RED produced `Missing expected rejection` after
     the descendant wrote its marker; GREEN requires both no marker and `ESRCH`.
   - source-layout SEO is exact at the document boundary: author and both icon
     links are absolute, canonical public pages use an unsuffixed social title,
     and canonical-less private/legal pages retain the root social metadata.
     The unit RED first lacked `socialMetadata`; the rendered HTML RED first
     lacked `<link rel="author">` and emitted relative icon URLs.

## Contract migration audit

- The contract scope materializes all 79 original names: 61 direct cases and
  18 cases expanded from four source tables.
- Scope is exactly **62 public / 17 server**. The Ontinyent/Escurial and
  electric-car-charger contracts are server contracts because they observe
  308/Location and 410/x-robots respectively.
- A root AST/printer audit found 709 `assert.*` calls in the frozen source and
  709 in the migrated contract, in identical normalized order/text, with zero
  differences and fingerprint
  `befbbd454c571e54c14eae8ab3851a6c198aee8410187661cdee43c6af433cc1`.
  The local regression test independently freezes the raw AST call-text
  sequence (`3ea6fe1c75b0af51c378991b048969d6cdf21df8c21387b6e03b32865d135722`)
  and reads only the target contract, never the source checkout.

## Tailwind/PostCSS expansion

`src/styles/reference.css` remains byte-exact: 485,081 bytes, SHA-256
`3a3e6c96604ba3d635cc8dbcb2eaa0639f261f03962da6e88a4c42c58f3e05c8`, including
its required `@import "tailwindcss"`. The first shell build failed to resolve
that import. Per the preauthorized plan conflict handling, this added only the
pinned source-equivalent `postcss.config.mjs` and exact dev dependencies
`tailwindcss@4.2.1` and `@tailwindcss/postcss@4.2.1` (including lockfile).
`reference-css.contract.mjs` verifies the emitted client CSS contains both the
Tailwind `.hidden{display:none}` utility and frozen `.site-header{` selector.

## Verification

- Focused unit suite: PASS (14/14 before the final lifecycle addition).
- Final full unit suite: PASS (144/144).
- `npm run check`: PASS, with two pre-existing informational hints in
  `eslint.config.js` and `scripts/lib/visual-contract.ts`.
- `npm run lint`: PASS.
- `npm run format:check`: PASS. `.prettierignore` names every frozen Task 1
  TypeScript copy explicitly (including `partner-data.ts`) plus the mechanically
  copied contract; this preserves their provenance without a broad future-content
  glob.
- `npm run build`: PASS, with the same two existing hints.
- `npm run test:http -- --scope public --test-name-pattern 'canonical|analytics before consent'`:
  PASS (3/3, including the emitted-CSS contract).
- Post-review focused metadata/HTML gate: PASS (metadata 3/3; absolute
  author/icon plus canonical HTTP contracts 2/2).
- `npm run test:e2e -- tests/e2e/chrome.spec.ts`: PASS (1/1).
- `npm run source:check`: PASS before and after implementation.
- The owned preview pool and Playwright server were audited after the gates:
  `astro preview status` reports no server; lifecycle fixtures leave no marker,
  PID or temporary directory. `test-results/` and `playwright-report/` are
  ignored and generated test output was removed.
- Final staged autonomous archive: PASS — `INDEPENDENT_OK source=staged
  tree=7bacee5aa512b335c3d6332269f4d4d58710e666 commands=4`, after `npm ci`,
  check, all 144 tests and build in an archive without `.git` or a sibling
  source checkout. Post-commit HEAD verification is reported with the commit.

## Self-review and boundaries

- `git diff --check` is clean.
- Product sources contain no Next/Vinext/server-only import; `src/pages` has no
  `.tsx` page. The built index contains only HeaderIsland and ConsentManager
  component islands, not a page-wide React root.
- No matrix, visual baseline, routing worker or source checkout was changed.
- `verify:public` is intentionally not run as an all-green gate in Task 2: its
  full public contract set covers pages reserved for Tasks 3–8. The prescribed
  global shell subset and its keyboard E2E are the valid Task 2 acceptance
  scope.

## Commit

`feat: add native Astro shell and global islands` (SHA reported with the final
handoff after post-commit verification).
