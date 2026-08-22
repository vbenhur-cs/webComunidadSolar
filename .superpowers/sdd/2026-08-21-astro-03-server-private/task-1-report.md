# Phase 3 — Task 1 report

## Scope and source boundary

- Base: `8f93f6dbfe06f691998099c0ed7e2f122f288896`.
- The source guard passed before and after the implementation:
  `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean`.
- The pre-existing source development group `49166` (Vite and workerd
  descendants) was observed but never signalled, read at runtime, or changed.
- Exact source `next.config.ts` was read through `readSourceBlob`; it declares
  `/socios`, `/socios/:path*`, `/guia-equipo`, and
  `/guia-equipo-nueva-web-comunidad-solar.md` with the four required private
  response headers.

## Delivered behavior

- `private-headers.ts` recognizes exactly the four source patterns, including
  `/socios/*` but excluding prefix lookalikes and guide descendants.
- `applyResponsePolicy()` first composes the existing Phase-2
  `normalizeWorkerResponse()`, then clones private responses and fills only
  missing source header defaults:
  `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex, nofollow, noarchive, noimageindex`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- Source-owned response directives win where the reference already emits a
  more specific contract: private HTML uses `no-store, must-revalidate`, and
  the Markdown handler owns its own noindex/cache headers. This is required by
  the captured source baseline and avoids overwriting route-handler behavior.
- The Worker now uses a pure response pipeline: `routeBeforeAstro()` returns
  captured 308/410 responses before the Astro handler, and normalizer plus
  private policy compose only after normal routing.
- Added `parity:http -- --scope routing`. It verifies only the redirect/gone
  contract family and is deliberately read-only: it refuses unsupported scopes
  and never writes or promotes `route-matrix.json`.

## TDD and debugging evidence

1. `tests/server/response-policy.test.ts` first failed with
   `ERR_MODULE_NOT_FOUND` for `src/lib/http/response-policy.ts`.
2. The routing harness RED failed with
   `Uso: parity-http.ts --scope foundation|public`; its injected runtime test
   also asserts a clean result cannot call `writeMatrix`.
3. During self-review, a direct reproduction showed a normalized private HTML
   response made the original body unreadable. The RED was
   `Body is unusable: Body has already been read`. Cloning the stream in the
   existing static HTML normalizer made the exact test green.
4. The same investigation found the robots content-type normalizer transferred
   its source stream. Its new focused RED had the same error; cloning that
   response stream restored source-response immutability without changing
   headers or body bytes.

## Verification

| Gate | Fresh result |
| --- | --- |
| policy/routing focused suite | PASS, 34/34 (includes emitted Worker) |
| `npm test` | PASS, 183/183 |
| `npm run format:check` | PASS |
| `npm run lint` | PASS |
| `npm run check` / build | PASS; 0 errors, 3 existing hints |
| `npm run parity:http -- --scope routing` | `HTTP_PARITY_OK scope=routing contracts=225 verified=263 pending=8 ... disposed=true` |
| matrix before/after routing | SHA-256 unchanged: `37e66574d81fa59a0195658173b56f4abfe86ab1ce157a363bcdda8195f5fb2b` |
| `git diff --check` | PASS |
| post-run source guard | `SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean` |

The three Astro-check hints are unchanged: TypeScript ESLint configuration
deprecation, an async suggestion in the visual harness, and source-faithful
`scrolling="no"`.

## Staged autonomy and closeout

- The product/test staged tree was verified before this ignored report joined
  the commit:
  `INDEPENDENT_OK source=staged tree=017386c5a3b616b092e24d31db45f9efe4c7faba commands=4`.
- The archive itself ran its full 183-test suite and build without a source
  sibling. The remaining closeout is the requested focused commit followed by
  the post-commit HEAD autonomy and process/status audit.
