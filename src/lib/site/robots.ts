const siteOrigin = "https://comunidadsolar.es";

export const robotsExcludedPaths = [
  "/socios",
  "/guia-equipo",
  "/guia-equipo-nueva-web-comunidad-solar.md",
  "/manganafer",
] as const;

export function buildRobotsPolicy(indexable: boolean): string {
  const rules = ["User-Agent: *"];
  if (indexable) {
    rules.push(
      "Allow: /",
      ...robotsExcludedPaths.map((path) => `Disallow: ${path}`),
    );
  } else {
    rules.push("Disallow: /");
  }
  rules.push(
    "",
    `Sitemap: ${siteOrigin}/sitemap.xml`,
    `Host: ${siteOrigin}`,
    "",
  );
  return rules.join("\n");
}
