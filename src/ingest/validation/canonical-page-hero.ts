import { parse as parseAstro } from "@astrojs/compiler";
import type { Node as AstroNode, TagLikeNode } from "@astrojs/compiler/types";

export interface StaticCanonicalPageHero {
  readonly image?: string;
  readonly imageAlt?: string;
}

function staticProps(node: TagLikeNode): StaticCanonicalPageHero | null {
  const values: { image?: string; imageAlt?: string } = {};
  const seenProps = new Set<string>();
  for (const attribute of node.attributes) {
    if (attribute.name !== "image" && attribute.name !== "imageAlt") {
      continue;
    }
    if (seenProps.has(attribute.name)) return null;
    seenProps.add(attribute.name);
    if (attribute.kind === "quoted") values[attribute.name] = attribute.value;
  }
  return Object.freeze(values);
}

/**
 * Reads only the canonical static PageHero surface after Task 8 has accepted
 * its canonical import and non-executable attributes. Expressions and aliases
 * never produce a value here.
 */
export async function staticCanonicalPageHeroes(
  source: string,
): Promise<readonly StaticCanonicalPageHero[] | null> {
  let parsed: Awaited<ReturnType<typeof parseAstro>>;
  try {
    parsed = await parseAstro(source, { position: false });
  } catch {
    return null;
  }
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 1)) {
    return null;
  }

  const heroes: StaticCanonicalPageHero[] = [];
  let ambiguous = false;
  const visit = (node: AstroNode): void => {
    if (node.type === "component" && node.name === "PageHero") {
      const props = staticProps(node);
      if (props === null) ambiguous = true;
      else heroes.push(props);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parsed.ast);
  if (ambiguous) return null;
  return Object.freeze(heroes);
}
