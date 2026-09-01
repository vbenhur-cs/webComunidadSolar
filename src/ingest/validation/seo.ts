import type { ChangePlan } from "../domain.ts";

function contentPath(plan: ChangePlan): string {
  return `src/content/generated/${plan.changeId}.json`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validates metadata, sitemap route identity and no-index privacy requirements. */
export function validateGeneratedSeo(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
): readonly string[] {
  const findings: string[] = [];
  const bytes = files.get(contentPath(plan));
  if (bytes === undefined) return ["seo.content: falta el contenido generado"];

  let content: Record<string, unknown> | null = null;
  try {
    content = asRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    // The common shape error below is clearer than a parser implementation detail.
  }
  if (content === null)
    return ["seo.content: el contenido no es JSON de página válido"];

  const metadata = asRecord(content.metadata);
  const privacy = asRecord(content.privacy);
  if (content.route !== plan.targetPath) {
    findings.push("seo.sitemap: la ruta de contenido no coincide con el plan");
  }
  if (metadata === null)
    return [...findings, "seo.metadata: faltan los metadatos"];
  const title = metadata.title;
  const description = metadata.description;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > 70
  ) {
    findings.push(
      "seo.title: el título debe ser texto no vacío de hasta 70 caracteres",
    );
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > 170
  ) {
    findings.push(
      "seo.description: la descripción debe ser texto no vacío de hasta 170 caracteres",
    );
  }
  if (typeof metadata.index !== "boolean") {
    findings.push("seo.index: el estado de indexación debe ser booleano");
  }
  if (privacy?.private === true && metadata.index !== false) {
    findings.push(
      "seo.privacy: las rutas privadas deben excluirse del sitemap",
    );
  }
  if (plan.publication.siteIndexable === false && metadata.index !== false) {
    findings.push("seo.publication: el perfil no indexable exige noindex");
  }
  return findings;
}
