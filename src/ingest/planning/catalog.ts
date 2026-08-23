import type { NormalizedRequest } from "../domain.ts";

/** The small, explicit set of shared Astro building blocks a plan may reuse. */
export const astroCatalog = Object.freeze({
  components: Object.freeze([
    "SiteLayout",
    "PageHero",
    "SectionHeading",
    "ButtonLink",
  ]),
  islands: Object.freeze([
    "BlogFilter",
    "ConsentManager",
    "CoverageFinder",
    "ManganaferInterestForm",
    "ManganaferQuoteForm",
  ]),
});

export interface CatalogSelection {
  reused: string[];
  new: string[];
  islands: string[];
}

/**
 * Catalog selection is intentionally conservative: content does not authorize
 * a new dependency or interactive island merely by mentioning one.
 */
export function selectCatalog(request: NormalizedRequest): CatalogSelection {
  const reused = ["SiteLayout"];
  if (request.seo.title !== null || request.content.length > 0) {
    reused.push("PageHero");
  }
  return { reused, new: [], islands: [] };
}
