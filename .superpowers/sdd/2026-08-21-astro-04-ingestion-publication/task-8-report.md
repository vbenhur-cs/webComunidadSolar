# Task 8 report — deterministic Astro output policy

## Scope delivered

- Added the closed six-block catalog and `BlockPageDefinition`, its JSON schema,
  and the seven Astro renderer components.
- Added the four generated-root sentinels required by the plan.
- Added `validateAstroSource` and
  `validateOutputPolicy(stagingPath, inventory, plan)`.
- Extended only `src/ingest/workspaces/policy.ts` with the authorized private
  staging record fields, controller-mint/approved-plan guard, and fixed
  package baseline reader.
- Added no runtime or development dependency. `package.json` and
  `package-lock.json` are unchanged.
- Did not add Task 9+ production code and did not modify the source repository.

## TDD evidence

Initial RED:

```text
npm run test:unit -- tests/ingest/output-policy.test.ts
exit 1 — ERR_MODULE_NOT_FOUND for src/content/block-catalog.ts
```

This was the expected failure for the absent Task 8 catalog/policy. Additional
security cycles were also observed before their fixes:

- unsafe `src` and spread attributes: 23/25 passed, 2 failed on the missing
  `link.unsafe` and `astro.spread` branches;
- substituted plan retaining the approved `planSha256`: 24/25 passed, 1 failed
  because the staging record was not yet bound to the full canonical plan;
- lockfile `resolved: file:../../outside.tgz`: 24/25 passed, 1 failed because
  local lock resolution had not yet been rejected.

Final GREEN:

```text
npm run test:unit -- tests/ingest/output-policy.test.ts
25 tests, 25 passed, 0 failed
```

The focused tests exercise real Task 7 workspaces and staged byte copies rather
than path mocks.

## Security interfaces and rulings honored

- `StagedAgentOutput` still exposes exactly `path`, `files`, and `sha256`.
  Private authority remains in a `WeakMap`; the staging root remains opaque and
  separate from the agent workspace.
- The Task 8 guard requires the exact controller-minted object, canonical path
  identity, baseline/change binding, and the full canonical approved plan. A
  clone, mismatched path, changed plan, or changed plan with a reused hash is
  rejected before policy evaluation.
- Policy reads only the independently supplied `files` inventory. It verifies
  exact hash keys, safe paths, regular single-link files, stable reads, and
  SHA-256 before interpreting bytes. It does not enumerate unchanged staging
  baseline files and has no route back to `AgentWorkspace` or agent-declared
  `generatedFiles`.
- The baseline manifest reader admits no caller path or repository. Its private
  staging record supplies repository and baseline; fixed Git argv reads only
  `package.json` and `package-lock.json` with `cat-file blob`.
- Package changes require both manifests in Gate 1, exact `name@version`
  declarations, an exact structural package/lock diff, no extra dependency,
  and no local/link lock resolution. A hostile working-tree `package.json`
  cannot redirect the comparison away from the bound commit.
- Blocks accept only `hero`, `feature`, `cta`, `steps`, `faq`, and `trust`, with
  closed nested objects and links restricted to `/`, `#`, HTTPS, `mailto`, and
  `tel`.
- Blocks require the generated JSON and `GeneratedBlockPage` route import.
  Freeform/hybrid require `SiteLayout`, their exact generated stylesheet, and
  only plan-approved hydrated islands. All modes require a closed content
  record with route, metadata, privacy, and a `contentSha256` equal to the
  controller-inventoried route hash.
- Astro is parsed with the pinned `@astrojs/compiler`; TypeScript import ASTs
  cover static/dynamic imports. Policy rejects parse errors, inline scripts,
  `on*`, spread and `set:html` attributes, unsafe active URLs, unallowlisted
  iframes, unapproved islands/dependencies, `next`, `vinext`, `node:*`, root
  traversal, unsafe CSS, and known secret patterns.

## Verification

```text
npm run test:unit -- tests/ingest/*.test.ts
244 tests, 244 passed, 0 failed

npm run format:check
pass

npm run lint
pass

npm run check
0 errors, 0 warnings, 3 pre-existing hints

npm run build
pass

npm run source:check
SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean

git diff --check
pass

git diff -- package.json package-lock.json
empty
```

The complete unit command ran 542 tests. It reported 541 passes and one
timing-sensitive pre-existing parity failure: under aggregate suite load,
`bounds a hanging browser close and still cleans every outer visual resource`
hit the 30 ms outer lifecycle timer before the browser-close timer. The exact
test then passed alone:

```text
node_modules/.bin/tsx --test --test-name-pattern "bounds a hanging browser close" tests/parity/visual-contract.test.ts
1 test, 1 passed, 0 failed
```

## Self-review

- Compared the changed/untracked file list against the Task 8 brief: only the
  listed Task 8 files, this report, and the narrowly authorized staging module
  extension are present.
- Confirmed base `b59ce1f38908e207aa76120e4c85fae8f32b2e1a` before the commit.
- Confirmed no manifest/lock change and no new dependency.
- Confirmed the public staging interface remains three-key and the output
  policy production module contains no `AgentWorkspace` or `generatedFiles`
  dependency.
- Mutation review is covered for wrong block type, wrong mode import, unsafe
  attribute/import/link, forged capability/path/plan, wrong inventory hash,
  config path, extra dependency, hostile lock resolution, and accidental scan
  of an unchanged hostile baseline file.

## Residual concerns

- The complete unit suite remains susceptible to the unrelated 30 ms parity
  timing flake described above; isolated rerun and the entire 244-test ingestion
  suite pass.
- There is no iframe-domain authority in `ChangePlan`; policy therefore rejects
  every generated iframe rather than inventing an allowlist.
- The exact dependency policy intentionally rejects lockfile transitive additions
  not individually representable by the current `plan.dependencies` contract.
  A future richer dependency-plan schema would need a separately reviewed
  relaxation.
