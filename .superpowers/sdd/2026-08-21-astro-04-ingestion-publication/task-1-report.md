# Phase 4 — Task 1 report

## Scope and preflight

- Base checked before implementation:
  `4dd854e0d0eb889c16ee18b38b8ceb3106f1da2f`.
- The linked worktree was clean. The pinned source guard was
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean` before work,
  and the pre-existing source Worker process group `49166` remained read-only
  and intact.
- Scope is limited to Phase 4 Task 1: closed ingestion contracts, canonical
  serialization, schema validation, and the state-transition predicate. No
  importer, state store, agent, candidate, publisher, or Task 2 work began.

## Canonical-contract resolution

- The master record initially defined `NormalizedRequest`, `ChangePlan`,
  `ApprovalRecord`, and `CandidateManifest`, but not the required Task 1
  `Attempt` record or raw `RequestInput` projection. Work paused before
  production code.
- The canonical master record now explicitly defines `RequestInput`,
  `ValidationResult`, and `AttemptRecord`. `RequestInput` is the closed raw
  projection with only the four required input fields; `inputKind` and
  `inputSha256` are derived during normalization. `AttemptRecord` stores only
  sanitized relative log/evidence paths, never log body content.

## TDD and implementation

1. RED: `npm run test:unit -- tests/ingest/domain.test.ts` exited 1 with
   `ERR_MODULE_NOT_FOUND` for `src/ingest/canonical-json.ts`, proving the
   domain test preceded implementation.
2. GREEN: the initial focused domain suite passed 12/12. It exercises a hand-checked
   canonical JSON digest, unsupported values and cycles, all six schemas,
   top-level and nested closed objects, raw-input derivation boundaries,
   exact path/change/hash/criteria constraints, publication profiles, both
   approval gates, attempt invariants, publishable-candidate validations, and
   gate-preserving state transitions.
3. During self-review, a focused RED proved that a symbol-own-property on an
   array was ignored because the array branch preceded the shared symbol check.
   Moving that check before the array branch is the sole fix; the same focused
   suite returned GREEN.
4. Review RED: the expanded focal suite failed with `Missing expected
   exception` for sparse arrays, hidden own properties, and accessors that the
   old array/object traversal could omit from a digest. GREEN reads own
   descriptors without invoking getters; only dense arrays and enumerable
   data-properties on plain objects are admitted.
5. Ajv now compiles all six schemas with `strictSchema: true` and
   `strictTypes: false`; the focused import/run is the schema-compilation
   proof. The schemas remain closed (`additionalProperties: false`) throughout.
6. Review RED: validated attempts with no validation/evidence, a terminal
   timestamp/failure/checkpoint mismatch, and candidates with no automatic
   validation were accepted. GREEN requires complete passed evidence and a
   finished/null-resume validated record; failed/rejected records retain a
   checkpoint, terminal failure, and finish time; candidate validations have a
   minimum of one entry.
7. The plan-required dependencies are exact in `package.json` and lockfile:
   Ajv 8.20.0, ajv-formats 3.0.1, YAML 2.9.0, yauzl 3.4.0, parse5 8.0.1,
   @astrojs/compiler 4.0.0, @types/yauzl 3.4.0, and @axe-core/playwright
   4.13.0.

## Verification ledger

- Initial `npm run test:unit -- tests/ingest/domain.test.ts`: PASS (12/12).
- Review RED: 12/13 for canonical input ownership and 12/15 for attempt and
  candidate invariants, both with the expected missing-rejection failures.
- Review GREEN: `npm run test:unit -- tests/ingest/domain.test.ts`: PASS
  (15/15).
- `SCHEMA_CLOSURE_OK files=6`: every object schema with an object type is
  explicitly closed.
- `npm ls --depth=0` for the required dependencies: PASS at the exact versions
  above.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS, 0 errors and the three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the source-faithful
  deprecated iframe `scrolling` attribute).
- `npm run source:check`: PASS —
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- Initial staged autonomy: PASS —
  `INDEPENDENT_OK source=staged tree=9de1f6b0625a36fca714f417a18c2e97f3ace421 commands=4`.
  The autonomous archive ran its complete suite (310/310) and build
  successfully. `npm ci` reported four moderate audit findings; they are
  non-blocking and no remediation is claimed here.

## Self-review and handoff

- No source checkout file, route matrix, deployed configuration, preview, or
  external service was modified.
- The report is re-staged with this review remediation. Its exact final tree
  is independently checked after staging and supplied to cached review rather
  than recursively editing this evidence file.
- The focused commit remains `feat: define ingestion domain contracts`.
- No Task 2 work has started.
