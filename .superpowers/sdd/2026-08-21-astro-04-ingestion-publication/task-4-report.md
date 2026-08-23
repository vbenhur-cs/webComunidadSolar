# Phase 4 — Task 4 report

## Scope and preflight

- Base before implementation: `2768f409ad7efec32c8408601164cd76ff93265a`.
- The worktree was clean before Task 4.4. The pinned source guard remained
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`; source Worker
  process group `49166` was observed only and was not modified.
- Scope is limited to inert page/folder/ZIP intake. It does not execute
  supplied content, build a candidate, change routes, publish data, or begin
  Task 5.

## TDD and implementation

1. RED: the initial importer test failed because the archive, HTML, page, and
   secret-scan modules did not exist. GREEN adds an inert importer for one
   supplied HTML, Markdown, Astro, or TSX entrypoint plus its declared local
   assets.
2. Inputs are opened as regular files with `O_NOFOLLOW` where available,
   bounded reads, `fstat`, lstat/realpath containment, and no execution,
   module resolution, or remote fetch. Directory traversal is lexical and ZIP
   processing is lazy; neither form is extracted to the host filesystem.
3. RED review cases close ZIP slip, symlink, encrypted/special Unix entry,
   entry-count, declared-versus-actual byte, total-byte, executable, Unicode
   normalization, case-fold collision, and every dotfile path. Dotfiles are
   rejected because the current canonical intake contract has no declaration
   field that could authorize one.
4. RED review cases close metadata `__proto__` loss, duplicate/alias/non-core
   YAML tags, supplied-secret bytes in metadata or any asset/container byte,
   directory-component collisions, and metadata identity confusion. External
   metadata is an optional argument only: when it is omitted, an internal
   `page-meta` file is required; in both forms canonical request metadata is
   still required and absence fails closed.
5. Imported source references include static `import`/`export`, literal
   `import(...)`, and literal `require(...)`; dynamic expressions reject
   rather than silently producing incomplete inventory. Source files are never
   evaluated.
6. Active SVG content is rejected before raw publication. The limited HTML
   sanitizer removes the Task 4 required executable/refresh/event surfaces;
   broader iframe and protocol output policy remains deliberately owned by
   Task 8 as defense in depth, rather than rewriting source bytes here.
7. Raw originals are copied only after validation to ignored,
   content-addressed intake leaves, with `0600` files, atomic hardlink
   publication, directory fsync, and cleanup of private temporary links.
8. Independent hardening review RED→GREEN closes raw-leaf mode weakening,
   external hardlinks, executable permission bits, and active SVG URL/data
   surfaces before any raw publication. Path collision detection uses a
   deterministic NFC/uppercase equality key only (including the documented
   sharp-S, Greek-theta, dotted/dotless-i boundaries); it does not claim to
   implement or rewrite Unicode default case folding. Distinct accented
   Spanish sibling names remain admissible.

## Verification ledger

- Focused Task 4.4 importer suite: PASS, 53/53.
- Combined importer focus (`page-importer` and `request-importer`): PASS,
  73/73.
- `npm run format:check`: PASS.
- `npm run lint -- --quiet`: PASS.
- `npm run check`: PASS, 0 errors and three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the
  source-faithful deprecated `scrolling` attribute).
- `npm run build`: PASS, including `astro check` with 0 errors and the same
  three inherited hints.
- Full `npm test`: fresh post-hardening run PASS, 418/418 in 42.2 seconds.
  A pre-hardening run reported 406/407 with a truncated failing diagnostic;
  immediate subsequent repeats were 407/407 and the current independent
  fresh run is 418/418. The earlier symptom remains recorded as transitory
  and non-reproduced rather than assigned an invented cause.
- `npm run source:check`: PASS before and after the build:
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Isolated manual import: PASS, reporting only `inputKind=page`, two assets,
  and a 64-character digest; its temporary artifact root was removed in
  `finally` without printing content or secret-like values.
- Staged autonomous archive: initial final-run PASS,
  `INDEPENDENT_OK source=staged tree=2676d06b706f855e0df42b0b4c1c782a4f1289a8 commands=4`.
  This factual report-only update is restaged and independently verified again
  before the precommit handoff, so the report does not falsely self-identify
  the tree it changes.

## Cleanup and self-review

- `.dev.vars` is absent. No Task 4.4 temporary package, artifact, or raw leaf
  remains under the system temporary directory.
- The existing ignored `.artifacts/intake` directory predates Task 4.4 and is
  empty (no raw leaves); it was left untouched. The source PGID remains
  intact.
- Synthetic fixtures contain no private bodies or credentials. Reports and
  command output record counts and digests only, not supplied content.
- The importer is intentionally fail-closed for unsafe paths, unknown input
  forms, malformed metadata, dynamic source references, active SVG, and any
  detected supplied secret.

## Handoff

- Intended commit after staged autonomous verification and cached review:
  `feat: import supplied page packages safely`.

## Fix round 1

- RED: focused importer run completed 57/63; the six expected failures showed
  quoted API-key/password assignments were accepted, declared hidden
  entrypoints were rejected, multiline/comment-separated literal imports were
  omitted, and a comment-separated dynamic expression was not rejected. No
  supplied secret body appeared in diagnostics.
- GREEN: quoted assignments now fail closed; import inventory uses the
  TypeScript parser as inert syntax analysis (never import/evaluation);
  multiline static and comment-separated literal imports are inventoried, and
  genuinely dynamic expressions reject.
- The path reader admits only a dot-prefixed page-extension leaf as a potential
  entrypoint. Page selection then requires exactly one hidden path and an exact
  external or incorporated metadata declaration. Hidden assets/directories,
  `.git`, and `node_modules` remain rejected.
- Added positive inert coverage for Markdown, Astro, and a single supplied page
  file.
- Fresh focused suite: PASS 64/64. `format:check`, lint, and Astro check:
  PASS (Astro check retained the three inherited informational hints).
- A parallel full-test/build attempt was invalidated by both commands racing on
  shared `dist`: 428/429 tests passed before the embedded runtime check found
  `dist/client` concurrently absent. A subsequent isolated full-suite run was
  interrupted by orchestration before its final TAP summary; the parent
  explicitly directed focused verification and handoff rather than another
  prolonged run. This is recorded as a verification limitation, not a passing
  full-suite claim.

## Fix round 2

- RED: the focused importer suite completed 64/66. A valid Astro `script`
  block silently omitted its multiline static and comment-separated literal
  dynamic local imports, and a true comment-separated dynamic expression in
  the same context was accepted.
- GREEN: Astro source is now parsed inertly with the Astro compiler parser.
  Only frontmatter and `script` text are passed to the existing TypeScript AST
  inventory; supplied modules are never imported, transformed, or evaluated.
  Literal local imports are inventoried and true dynamic expressions remain
  fail-closed.
- Fresh focused importer suite: PASS 66/66. Formatting, lint, and Astro check:
  PASS with the same three inherited informational hints. Per controller
  direction, the full suite was not run in this round.
- Self-review found the change limited to source analysis and two public
  importer regressions; archive, secret, raw-publication, and path policy are
  unchanged.
