import type { CompositionMode, NormalizedRequest } from "../domain.ts";

export type SelectedMode = Exclude<CompositionMode, "auto">;

const siteChrome =
  /(?:class\s*=\s*["'][^"']*\b(?:site-root|site-header)\b[^"']*["']|\bSiteLayout\b)/u;
// A markup-like opener is conservatively page content even when malformed.
// Plain comparison text such as "1 < 2" has no such opener and remains text.
const markup = /(?:<!--|<![A-Za-z]|<\/?[A-Za-z]|<>|<\/?>)/u;

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
