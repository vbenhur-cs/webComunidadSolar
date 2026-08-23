import type { CompositionMode, NormalizedRequest } from "../domain.ts";

export type SelectedMode = Exclude<CompositionMode, "auto">;

const siteChrome =
  /(?:class\s*=\s*["'][^"']*\b(?:site-root|site-header)\b[^"']*["']|\bSiteLayout\b)/u;

/** Selects the composition mode without interpreting supplied page content. */
export function selectMode(request: NormalizedRequest): SelectedMode {
  if (request.mode !== "auto") {
    return request.mode;
  }

  if (request.inputKind === "request") {
    return "blocks";
  }

  return siteChrome.test(request.content) ? "hybrid" : "freeform";
}
