# Phase 4 — Task 3 report

## Scope and preflight

- Base checked before implementation:
  `457e858a7fcdec255b2f60b88ceceadf6c0634c6`.
- The linked worktree was clean. The pinned source guard was
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`; the source
  Worker group `49166` was observed only and remains untouched.
- Scope is limited to importing detailed request files. No source checkout,
  route, matrix, generated page, candidate worktree, state transition, or
  publication behavior changed.

## TDD and implementation

1. RED: `npm run test:unit -- tests/ingest/request-importer.test.ts` failed
   with `ERR_MODULE_NOT_FOUND` for `src/ingest/importers/request.ts`. The
   fixture acceptance therefore preceded all importer production code.
2. GREEN: JSON, YAML, and Markdown normalize to one closed
   `NormalizedRequest`; their synthetic fixture has the same canonical digest.
   YAML uses the core schema, alias count zero, and an exact core-tag allowlist
   (`null`, `bool`, `int`, `float`, `str`, `map`, `seq`) before converting to
   JavaScript data. Markdown requires YAML frontmatter and takes its body as
   `content`.
3. The importer normalizes decoded text and every parsed string to NFC/LF,
   validates the raw closed schema, materializes every optional default, hashes
   canonical normalized data without `inputSha256`, inserts the hash, and
   revalidates that hash before returning a request.
4. RED: a supplied artifact root was accidentally treated as its parent, so
   the expected raw directory was absent (`ENOENT`). GREEN treats
   `artifactRoot` as the exact root, copying original bytes to
   `intake/<changeId>/<inputSha256>/raw/<raw-sha256>.<ext>` without formatting
   the input.
5. RED: CRLF Markdown failed with `Markdown requiere frontmatter YAML` before
   parsing. GREEN normalizes decoded text before selecting a parser; a single
   canonical blank separator after a Markdown frontmatter fence is structural,
   while any additional blank remains in the body.
6. Review RED: a JSON `__proto__` key was lost while copying data into `{}` and
   passed the closed schema (`Missing expected rejection.`). GREEN uses a
   prototype-free output record, so Ajv sees and rejects the forbidden key.
7. Review RED: the parser accepted `!!binary`, `!!timestamp`, and
   `!!js/function`, because it accepted every standard YAML tag. GREEN uses
   the exact core allowlist. Independent alias-only and duplicate-key-only
   cases stay rejected, as do custom tags.
8. Review RED: raw intake paths and an existing leaf could follow a symlink
   outside a supplied artifact root. GREEN validates every artifact-root and
   child component with `lstat` plus canonical containment, opens leaf files
   with `O_NOFOLLOW`, and accepts only matching regular files.
9. Review RED: an input could grow after its pre-read stat. GREEN reads once
   from a single `O_NOFOLLOW | O_NONBLOCK` file handle, verifies its `fstat`,
   and reads at most 1 MiB plus one byte before parsing and raw copying the
   same returned bytes.
10. Review RED: a raw hardlink publication left no observable directory sync.
    GREEN writes mode `0600`, publishes exactly one leaf atomically, removes
    its private temporary link, and fsyncs the raw directory afterwards. A
    repeat import exercises the `EEXIST` path: it preserves the original inode
    and bytes, leaves one leaf, and leaves no `.intake-*.tmp` in success or the
    tested existing-symlink failure path.

## Boundary and artifacts

- Original inputs intentionally live only below ignored
  `.artifacts/intake/<changeId>/<inputSha256>/raw/`. The normalized
  `request.json` is not persisted into `.change-state` in this task: Task 12
  owns CLI intake and state persistence.
- Every test that can copy raw input supplies a temporary `artifactRoot` and
  removes it in `finally`. An earlier ignored intake directory created while
  establishing the tests was uniquely attributable to this task and moved
  recoverably out of the worktree; no Task 3 raw intake remains there.
  Production's one-argument interface continues to place raw input below the
  project `.artifacts` directory.
- Fixtures are synthetic public content. No private body, secret, remote
  request, source data, or `.dev.vars` value was read or emitted.

## Verification ledger

- Initial importer RED: missing module as recorded above.
- Focused importer suite: PASS, 20/20 after the final review hardening.
- Explicit fixture import: PASS; repeated canonical hash is
  `58757beeb9a5b3cd4b4345e712c4fdb8246c10c52929938fcf305969d6892209`.
- `npm run format:check`: PASS after the final review.
- `npm run lint`: PASS after the final review.
- `npm run check`: PASS after the final review, 0 errors and the three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the source-faithful
  deprecated iframe `scrolling` attribute).
- `npm test`: PASS, 365/365 after the final review tests.
- `npm run build`: PASS, including `astro check` (0 errors and the same three
  inherited hints).
- `npm run source:check`: PASS:
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- The explicit isolated fixture import repeated one YAML request with the same
  canonical hash and removed its temporary artifact root. Cached diff and
  staged-autonomy evidence passed for the exact staged Task 3 tree; its literal
  result and tree identifier are supplied to cached review without recursively
  editing this report after the final archive run.

## Self-review and handoff

- The importer never evaluates Markdown, YAML, or JSON content. It accepts
  only regular input files with the four declared extensions, rejects unsafe
  YAML graph features, and preserves original input bytes separately from
  canonical normalized data.
- The code has no runtime dependency on the source checkout. No Phase 4 Task
  4 work has begun.
- Intended focused commit after cached review:
  `feat: ingest structured page requests`.
