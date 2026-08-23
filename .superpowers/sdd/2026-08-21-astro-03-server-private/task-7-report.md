# Phase 3 — Task 7 report

## Scope and preflight

- Base checked before implementation: `6dee7567cccf0436ae114dffc0a840c0787773db`.
- The worktree was clean and the pinned source guard reported
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean` before and after
  the work.
- The immutable source blobs for the Manganáfer quote configuration and quote
  endpoint were read through the pinned source-reference flow only. The
  sibling checkout and its process group `49166` were never written, built, or
  terminated.
- Scope is limited to the explicit Worker environment DTO, pure quote handler,
  minimal Astro POST route, synthetic fixtures, and focused server tests. No
  route matrix, visual baseline, HTTP baseline, public page, or package lock
  changed.

## TDD and implementation

1. The initial focused server test was RED with
   `ERR_MODULE_NOT_FOUND` for `src/lib/manganafer/quote.ts`. The initial
   environment-boundary RED then showed that the quote configuration module
   did not export the required explicit binding selector. Both are GREEN in
   the final focused suite (`14/14`).
2. `handleQuoteRequest(request, { env, fetcher })` is pure at its boundary:
   tests inject a synthetic environment and fetcher, so no test makes a real
   upstream request or inherits a process-wide secret. The endpoint passes only
   the ten declared quote bindings from the Cloudflare environment.
3. The source's framework-only `server-only` marker is intentionally omitted:
   this Astro Worker module has no Next runtime dependency, and explicit
   dependencies retain the source behaviour without a shim.
4. The source's CUPS regex, normalisation, plant coordinates, one-kilometre
   business decision, candidate loop, financial fields, status codes, and all
   four private response headers are preserved. Responses never include an
   upstream token or CUPS value.
5. Commercial configuration is covered at every source boundary, including
   empty-string coercion, integer floor for available panels, rounded panel
   power, default maximum, and the `1..24` clamp.
6. The source only checks its declared `4096`-byte `Content-Length`. Task 7
   extends that source behaviour by applying the same exact 4096-byte limit to
   the actual request stream before either upstream is contacted. This is an
   explicit plan hardening, not a claim that the source already consumed the
   stream safely.

## Factual plan conflicts resolved by the pinned source

- The plan snippet described a valid CUPS outside the coverage radius as a
  `422`. The pinned endpoint returns `200` with a successful, non-eligible
  business result and the rounded distance instead. The port preserves the
  source `200`; `422` remains reserved for a valid CUPS whose location or
  invoice data cannot support a calculation.
- The plan's generic 24 KiB wording conflicts with the endpoint's explicit
  4096-byte threshold. The port preserves `4096` for both declared and actual
  bodies; a 24,001-byte request is consequently rejected as oversized too.

## Verification ledger

- `npm run test:unit -- tests/server/manganafer-quote.test.ts`: PASS (`14/14`).
- `npm run format:check`: PASS.
- `npm run lint`: PASS.
- `npm run check`: PASS, 0 errors and three inherited informational hints
  (ESLint config API, visual-helper async suggestion, and the
  source-faithful deprecated iframe `scrolling` attribute).
- `npm test`: PASS (`253/253`, 0 failures, 47.265 s).
- `npm run build`: PASS (0 errors; the same three inherited hints).
- `npm run test:http -- --scope server --test-name-pattern 'Manganáfer CUPS
  server-side|one kilometre'`: PASS (`3/3`). It covers the local map and
  invalid/unconfigured endpoint behaviour only; no external quote service is
  contacted.
- `npm run source:check`: PASS —
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- `npm run parity:manifest -- --check`: PASS — `SOURCE_MANIFEST_OK 271`.
- `npx tsx scripts/capture-http-baseline.ts --check`: PASS —
  `HTTP_BASELINE_OK 311 81`. The new server endpoint has no frozen public
  baseline or visual/matrix row, so neither promotion nor visual capture is
  applicable in this task.

## Self-review and cleanup

- `git diff --check` is clean. The product route uses a typed, explicit quote
  binding selection rather than an unsafe environment cast; the handler keeps
  `fetch` injected and never logs request data.
- The route matrix is untouched; its SHA-256 remains
  `1fb8c49d265ffe4080927ff9fd5928af5a99c9f6be1bab6fa303c188238e83cf`.
- `.dev.vars` is absent. No Task 7 runtime, preview process, temporary source
  archive, or task-specific artifact remains. The pre-existing source group
  `49166` remains intact. Existing ignored baseline artifacts were not read,
  altered, or removed.
- Test fixtures, source, and this report contain only synthetic data; no real
  customer identity, CUPS, bearer token, or private response body is recorded.

## Commit

`npm run verify:independent -- --staged` passed with
`INDEPENDENT_OK` for the exact staged tree. The tree is paused for cached
review before the requested commit:

```text
feat: port Manganáfer quote service
```
