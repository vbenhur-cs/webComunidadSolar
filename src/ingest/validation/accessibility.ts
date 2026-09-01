import type { ChangePlan } from "../domain.ts";

import { staticCanonicalPageHeroes } from "./canonical-page-hero.ts";

function routePath(plan: ChangePlan): string {
  return plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
}

function quotedAttribute(source: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(
    source,
  );
  return match?.[2];
}

/** Performs the static accessibility checks that can run before a browser audit. */
export async function validateGeneratedAccessibility(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
): Promise<readonly string[]> {
  if (plan.selectedMode === "blocks") return [];
  const bytes = files.get(routePath(plan));
  if (bytes === undefined) return ["a11y.route: falta la ruta generada"];
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return ["a11y.route: la ruta no es UTF-8 válido"];
  }

  const findings: string[] = [];
  const heroes = await staticCanonicalPageHeroes(source);
  if (heroes === null) {
    return ["a11y.route: la ruta no contiene Astro estático válido"];
  }
  for (const match of source.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    if (quotedAttribute(tag, "alt") === undefined) {
      findings.push(
        "a11y.alt: toda imagen generada debe declarar texto alternativo",
      );
    }
  }
  for (const hero of heroes) {
    if (
      hero.image !== undefined &&
      (hero.imageAlt === undefined || hero.imageAlt.trim().length === 0)
    ) {
      findings.push(
        "a11y.page-hero-alt: PageHero con imagen requiere imageAlt estático no vacío",
      );
    }
  }
  const ids = new Set<string>();
  for (const match of source.matchAll(/\bid\s*=\s*(["'])(.*?)\1/giu)) {
    const id = match[2] ?? "";
    if (ids.has(id)) findings.push(`a11y.id: el id ${id} está duplicado`);
    ids.add(id);
  }
  return findings;
}
