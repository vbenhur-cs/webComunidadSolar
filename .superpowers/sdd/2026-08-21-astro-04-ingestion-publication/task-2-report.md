# Phase 4 — Task 2 report

## Scope and preflight

- Base checked before implementation:
  `9ec734a5da25e3986983642d1f5b1c7923d667a7`.
- The linked worktree was clean. The pinned source guard was
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`; the source
  Worker group `49166` was only observed and left intact.
- Scope is limited to Phase 4 Task 2: durable change state, secure paths,
  inter-process locks, and a tamper-evident journal. No importer, candidate
  worktree, publication flow, external service, or source checkout write was
  started.

## Canonical state contract

- Task 1 had not yet defined the operational state record required by Task 2.
  Per the approved direction, the canonical master record and ingestion domain
  now define `ChangeRecord`, `TransitionEvent`, `JournalEvent`, and the four
  resumable checkpoints. `state.json` is deliberately only operational state;
  request, plan, approvals, attempts, and candidate material have separate
  paths.
- The first transition is only `null -> received`, yielding revision 1 and
  `attempt-000001`. Adjacent transitions use `allowedTransition`; retry is
  limited to `failed` or `rejected`, retains the recorded checkpoint, and
  creates a new attempt.
- `.change-state/` remains ignored and is rejected beneath `.agent-worktrees`.
  The additional ignored intake/candidate artifact paths do not ignore the
  sanitized, trackable `changes/` record.

## TDD and implementation

1. RED: the initial focused store command failed with
   `ERR_MODULE_NOT_FOUND` for `src/ingest/paths.ts`; no production store
   existed. GREEN introduced bounded change paths, regular-file reads, atomic
   writes, lock ownership, transitions, and the hash-chain verifier.
2. RED fixtures covered direct/nested symlink roots, atomic pre-rename failure,
   concurrent parent admission, malformed/live/remote stale locks, journal
   tampering/truncation/sequence, retry checkpoints, and an undefined callback
   rejection. GREEN uses `lstat`/`realpath`, `open(..., "wx")`, a local
   PID-only stale check, and verified canonical journal events.
3. Review RED: a stale lock predating the first transition returned revision 1
   without a `lock-recovered` event. GREEN defers that recovery only until the
   valid initial `received` event is durable, then appends it while still
   holding the lock.
4. Crash-boundary REDs inject a state-snapshot failure after the journal write
   and model both durable mismatches (new journal/old state and new state/old
   journal). GREEN rolls back the journal atomically when possible and makes
   `readChange` fail closed for either mismatch. A journal without state is not
   silently overwritten by a later initial transition; lock and temporary-file
   cleanup are asserted.
5. The journal is rewritten as full canonical NDJSON through `writeAtomic`:
   durable temporary file, file fsync, rename, and parent-directory fsync. It
   never uses append-only partial writes. Initial rollback also fsyncs the
   deletion directory.
6. Final review RED: a cryptographically self-consistent first event could use
   the reserved `retry` or `lock-recovered` type. GREEN rejects either before
   journal state derivation. A separate normal `transition("retry", ...)` RED
   initially did not reject; GREEN reserves that type exclusively for
   `retryChange` before either durable snapshot can change.
7. Stale-lock recovery had a compare/unlink/create TOCTOU: two recoverers
   could both validate the stale owner and the second could unlink the first
   replacement. A deterministic interleaving RED let both callbacks enter
   (`Missing expected rejection.`). GREEN uses a private, `wx` acquisition
   guard for the entire recovery window; the other recoverer fails closed
   before its callback. The guard is removed on success and on an injected
   recovery failure. The test-only interleaving hook is scoped to store options
   and is not used by production callers.
8. Lock release REDs covered both a changed owner and a disappeared owned lock.
   The latter initially returned silently (`Missing expected rejection.`).
   GREEN rejects either condition, so a callback which removes its own lock
   cannot be reported as successful. The stress fixture now audits temporary
   files, locks, and recovery guards together.
9. Cached review found that a process killed after creating the recovery guard
   could block the change forever. REDs showed the prior immediate block for a
   local stale guard, no local PID probe for a remote guard, and an abrupt
   child process that exited immediately after acquiring its guard. GREEN
   applies the same local-host, PID-absent, older-than-30-minute rule to that
   guard. It atomically renames the claimed stale guard to a unique quarantine,
   validates its bytes, and only then creates a new guard. If a newer owner was
   moved during the race, it is restored with a non-overwriting link and the
   operation fails closed. The guard is always removed before the callback;
   stress residue auditing includes quarantine names.

## Verification ledger

- Focused state-store suite: PASS, 32/32.
- Direct multiprocess stress fixture: PASS three consecutive times —
  `STRESS_LOCKS_OK owners=1 blocked=7 residue=0` each time.
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS, 0 errors and the three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the source-faithful
  deprecated iframe `scrolling` attribute).
- Full `npm test`: PASS, 345/345.
- `npm run build`: PASS, with the same 0 errors / 3 inherited hints.
- `npm run source:check`: PASS before and after implementation —
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- The earlier staged autonomy run is superseded by this review hardening. The
  exact final staged tree is independently verified after this report and its
  review files are staged; the literal result and tree are supplied with the
  pre-commit handoff to avoid a self-referential report/tree rewrite.

## Self-review and handoff

- The store verifies the journal before every returned state. It derives the
  full state record from verified events and rejects tampering, truncation,
  missing counterpart snapshots, reserved initial event types, and unsafe
  path/lock ownership rather than repairing an ambiguous crash boundary. Its
  recovery guard also closes the stale-owner unlink/create window and lock
  release fails closed if ownership has vanished. A stale recovery guard is
  recoverable only for a dead local owner after the fixed age threshold; remote
  and live owners remain fail-closed, and a quarantine never reaches a
  callback.
- No source data, request body, secrets, private content, external process, or
  remote service was used. Test fixtures use only temporary directories and
  synthetic markers.
- The exact staged Task 2 tree is supplied separately to cached review after
  the final report-only autonomy run. No commit is made before that review.
