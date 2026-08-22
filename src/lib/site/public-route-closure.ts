export interface PublicRouteClosureEntry {
  path: string;
  kind: string;
}

export interface DeferredPublicRoute {
  path: string;
  owner: "Phase 3";
  reason: string;
}

/**
 * These source-public URLs are intentionally not implemented until Phase 3.
 * Keeping the exception here makes the sitemap, link audit and public gates
 * agree without turning the unimplemented route into an invented placeholder.
 */
export const PHASE3_DEFERRED_PUBLIC_ROUTES: readonly DeferredPublicRoute[] = [
  {
    path: "/comunidades-energeticas/manganafer",
    owner: "Phase 3",
    reason:
      "La landing Manganáfer y sus islas de formulario dependen de sus APIs de servidor.",
  },
];

export function isPhase3DeferredPublicRoute(path: string): boolean {
  return PHASE3_DEFERRED_PUBLIC_ROUTES.some((route) => route.path === path);
}

/**
 * Lets frozen contract consumers skip only the declared Phase 3 route while
 * still failing closed if a source sitemap stops enumerating that exception.
 */
export function requireExactPhase3DeferredPublicRoutes(
  paths: Iterable<string>,
  consumer: string,
): void {
  const expected = PHASE3_DEFERRED_PUBLIC_ROUTES.map((route) => route.path);
  const actual = Array.from(paths).filter(isPhase3DeferredPublicRoute);

  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new Error(
      `${consumer} must enumerate the exact Phase 3 deferred routes: ${expected.join(", ")}; received: ${actual.join(", ") || "(none)"}`,
    );
  }
}

/** Phase 2 closes every manifest route except APIs, private pages and Phase 3. */
export function isPhase2PublicRoute(entry: PublicRouteClosureEntry): boolean {
  return (
    entry.kind !== "api" &&
    entry.kind !== "private-page" &&
    !isPhase3DeferredPublicRoute(entry.path)
  );
}
