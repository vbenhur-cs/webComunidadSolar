import { parseSafeYaml } from "./common.ts";

export function parseMarkdownFrontmatter(source: string): unknown {
  if (!source.startsWith("---\n")) {
    throw new TypeError("Markdown requiere frontmatter YAML");
  }

  const closing = source.indexOf("\n---\n", 4);
  if (closing < 0) {
    throw new TypeError("Markdown requiere frontmatter YAML");
  }

  const frontmatter = parseSafeYaml(source.slice(4, closing));
  if (
    frontmatter === null ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new TypeError("El frontmatter debe ser un objeto");
  }
  if (Object.hasOwn(frontmatter, "content")) {
    throw new TypeError("El frontmatter no puede declarar contenido");
  }

  const bodyStart = closing + "\n---\n".length;
  const content = source.startsWith("\n", bodyStart)
    ? source.slice(bodyStart + 1)
    : source.slice(bodyStart);

  return {
    ...frontmatter,
    content,
  };
}
