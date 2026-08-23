import { assertNormalizedRequest } from "../importers/common.ts";
import type { NormalizedRequest } from "../domain.ts";

import type { SelectedMode } from "./mode.ts";

export interface OutputPaths {
  route: string;
  componentsDir: string;
  content: string;
  stylesheet: string;
  assetsDir: string;
}

export interface SourceManifestRoute {
  path: string;
  kind?: string;
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function assertSafeOutputPath(path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new TypeError("La ruta de salida no es segura");
  }
  return path;
}

/**
 * Returns the exact generated roots a later candidate may write. Directories
 * are named exactly, never widened to a shared parent directory.
 */
export function outputPaths(
  request: NormalizedRequest,
  mode: SelectedMode,
): OutputPaths {
  void mode;
  const normalized = assertNormalizedRequest(request);
  const route =
    normalized.targetPath === "/"
      ? "src/pages/index.astro"
      : `src/pages${normalized.targetPath}.astro`;
  const result = {
    route,
    componentsDir: `src/components/generated/${normalized.changeId}`,
    content: `src/content/generated/${normalized.changeId}.json`,
    stylesheet: `src/styles/generated/${normalized.changeId}.css`,
    assetsDir: `public/generated/${normalized.changeId}`,
  };

  for (const path of Object.values(result)) {
    assertSafeOutputPath(path);
  }
  return result;
}

export function routeExists(
  targetPath: string,
  routes: readonly SourceManifestRoute[],
): boolean {
  return routes.some(
    (route) =>
      route.path === targetPath &&
      route.kind !== "api" &&
      route.kind !== "asset",
  );
}
