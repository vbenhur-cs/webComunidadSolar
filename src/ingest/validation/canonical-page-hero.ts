import { parse as parseAstro } from "@astrojs/compiler";
import type { Node as AstroNode, TagLikeNode } from "@astrojs/compiler/types";

export interface StaticCanonicalPageHero {
  readonly image?: string;
  readonly imageAlt?: string;
}

function quotedProp(node: TagLikeNode, name: string): string | undefined {
  const attribute = node.attributes.find(
    (candidate) => candidate.name === name && candidate.kind === "quoted",
  );
  return attribute?.kind === "quoted" ? attribute.value : undefined;
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
  const visit = (node: AstroNode): void => {
    if (node.type === "component" && node.name === "PageHero") {
      const image = quotedProp(node, "image");
      const imageAlt = quotedProp(node, "imageAlt");
      heroes.push(
        Object.freeze({
          ...(image === undefined ? {} : { image }),
          ...(imageAlt === undefined ? {} : { imageAlt }),
        }),
      );
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parsed.ast);
  return Object.freeze(heroes);
}
