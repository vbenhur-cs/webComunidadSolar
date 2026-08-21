# Phase 2 — Task 1 report

## Scope and preflight

- Base checked before changes: `bf8856e4c5d6fb4e195e77e032a53e8ca6cc3590`.
- Worktree was clean and `npm run source:check` reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Read the complete Phase 2 plan, migration master constraints, ingestion spec,
  and Task 1 section before product changes.
- All source reads/copies used the pinned immutable commit
  `68ea294c54dc5e15e20f470fc421a239927565a8` through
  `copySourceFiles` / `readSourceBlob`; the source checkout was never written,
  built, installed, or started.

## TDD

1. Added `tests/content/source-copies.test.ts` first.
2. RED: `npm run test:unit -- tests/content/source-copies.test.ts` failed with
   `ERR_MODULE_NOT_FOUND` for `src/content/blog-data.ts`, as expected because no
   copied destination existed.
3. Ran the prescribed copier with the nine Task 1 maps and
   `--public-from-manifest`: `SOURCE_COPIED 86`.
4. Removed only the leading `import "server-only";` plus its blank line from
   `src/content/partner-data.ts`. This is the sole allowed adjustment: the
   target is 9,282 bytes with SHA-256
   `99305b629927aaf9dc9b8de9476b4863f03221c01d241e61d29f579bc7609d79`;
   provenance deliberately retains the original immutable source blob
   (`8c7e0b4f…`, 9,305 bytes).
5. GREEN: the focal test passes 4/4, covering data cardinalities (20 / 21 / 19
   / 3), runtime exports, all asset hashes/bytes/provenance, CSS hash, regular
   files rather than symlinks, and absence of `server-only`, Next/Vinext, or
   source-checkout runtime dependencies.

## Imported inventory

- 7 TypeScript data modules, one guide Markdown blob, and one CSS blob.
- 77 manifest public assets, all byte-identical.
- Provenance now has 87 deterministic entries: the pre-existing legacy entry,
  nine Task 1 content/style entries, and 77 public asset entries.
- `src/styles/reference.css`: 485,081 bytes,
  `3a3e6c96604ba3d635cc8dbcb2eaa0639f261f03962da6e88a4c42c58f3e05c8`.

## Autonomy regression discovered during full test

The existing independence scanner treated any quoted `"next"` value as a Next
module reference. The exact frozen community data legitimately contains the
domain union value `"next"`, which caused the first full suite to fail with
`content/community-data.ts: next`. This was not a source dependency and could
not be fixed by changing a byte-exact imported blob.

Added a focused RED fixture proving content literals named `next` are allowed;
then narrowed the scanner to actual static imports/re-exports, dynamic imports,
and `require()` module specifiers. Existing tests still prove detection of
`next`, `vinext`, and backtick dynamic imports. This preserves the fail-closed
runtime-dependency intent without weakening it for imported data.

This necessary autonomy repair was committed separately before the content
import to keep history focused:
`ab526fe239ac53c4ca7439c54bbb768f4b5b2cb0`
(`fix: distinguish Next imports from content literals`).

## Verification

- Focal source-copy test: PASS (4/4).
- Focused independence scanner tests: PASS (3/3).
- `prettier --check` for touched executable/test files: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS, with two existing informational hints in
  `eslint.config.js` and `scripts/lib/visual-contract.ts`.
- Full `npm test`: PASS (131/131).
- `npm run build`: PASS (same two existing informational hints).
- `npm run verify:independent -- --staged`: PASS — `INDEPENDENT_OK`, after
  `npm ci`, check, all 131 tests, and build inside the Git archive without a
  sibling source checkout.
- Post-change `npm run source:check`: `SOURCE_OK
  68ea294c54dc5e15e20f470fc421a239927565a8 clean`.

## Self-review

- No pages, routing, matrix, baseline, deployment configuration, or source
  checkout files were changed.
- Copied content and assets are regular files; tests assert no symlink and no
  source-runtime dependency.
- No copied blob was reformatted. Partner data is the documented one-import
  exception above.
- `git diff --check` is clean for every task-written file. Its only four
  diagnostics are trailing Markdown spaces already present in the frozen guide
  source; they are intentionally retained for byte-exact provenance rather than
  normalized.

## Commit

`content: import frozen site data and assets` (the resulting SHA is reported
to the operator with this handoff).
