import type { CompositionMode, NormalizedRequest } from "../domain.ts";

export type SelectedMode = Exclude<CompositionMode, "auto">;

const siteChrome =
  /(?:class\s*=\s*["'][^"']*\b(?:site-root|site-header)\b[^"']*["']|\bSiteLayout\b)/u;
const markup = /<[A-Za-z][^>]*>/u;

/** Selects the composition mode without interpreting supplied page content. */
export function selectMode(request: NormalizedRequest): SelectedMode {
  if (request.mode !== "auto") {
    return request.mode;
  }

  if (siteChrome.test(request.content)) {
    return "hybrid";
  }

  if (request.inputKind === "request" && !markup.test(request.content)) {
    return "blocks";
  }

  return "freeform";
}
