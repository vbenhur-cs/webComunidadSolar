import { isApprovedGeneratedLink } from "../../content/block-catalog.ts";
import type { ChangePlan } from "../domain.ts";

function routePath(plan: ChangePlan): string {
  return plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
}

function contentPath(plan: ChangePlan): string {
  return `src/content/generated/${plan.changeId}.json`;
}

function decode(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function jsonLinks(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => jsonLinks(item, result));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "href" && typeof child === "string") result.push(child);
      jsonLinks(child, result);
    }
  }
  return result;
}

function normalizedInternalPath(value: string): string | null {
  try {
    const url = new URL(value, "https://comunidadsolar.es");
    if (url.origin !== "https://comunidadsolar.es") return null;
    if (!value.startsWith("/") && !value.startsWith("https://")) {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}

function normalizedRoutePath(path: string): string {
  return path === "/" ? "/" : path.replace(/\/+$/u, "");
}

/** Checks static generated links and resolves freeform fragment references locally. */
export function validateGeneratedLinks(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
  knownRoutes: ReadonlySet<string> = new Set(["/", plan.targetPath]),
  knownAssets: ReadonlySet<string> = new Set(),
): readonly string[] {
  const findings: string[] = [];
  const routeSource = files.get(routePath(plan));
  const contentSource = files.get(contentPath(plan));
  const source = routeSource === undefined ? null : decode(routeSource);
  if (source === null) {
    findings.push("link.source: la ruta no contiene UTF-8 estático válido");
    return findings;
  }

  const routeLinks: Array<{
    readonly value: string;
    readonly kind: "href" | "src";
  }> = [];
  for (const match of source.matchAll(/\b(href|src)\s*=\s*(["'])(.*?)\2/giu)) {
    const value = match[3] ?? "";
    routeLinks.push({
      value,
      kind: match[1]?.toLowerCase() === "src" ? "src" : "href",
    });
  }
  const contentLinks: string[] = [];
  if (contentSource !== undefined) {
    const text = decode(contentSource);
    try {
      if (text === null) throw new TypeError("invalid UTF-8");
      jsonLinks(JSON.parse(text), contentLinks);
    } catch {
      findings.push(
        "link.content: el contenido no permite validar sus enlaces",
      );
    }
  }

  for (const value of [
    ...routeLinks.map((link) => link.value),
    ...contentLinks,
  ]) {
    if (!isApprovedGeneratedLink(value)) {
      findings.push(
        `link.authority: ${value || "(vacío)"} no tiene autoridad aprobada`,
      );
    }
  }

  for (const reference of [
    ...routeLinks.map((link) => ({
      value: link.value,
      allowsRoute: link.kind === "href",
    })),
    ...contentLinks.map((value) => ({ value, allowsRoute: true })),
  ]) {
    if (
      !isApprovedGeneratedLink(reference.value) ||
      reference.value.startsWith("#")
    ) {
      continue;
    }
    const path = normalizedInternalPath(reference.value);
    if (
      path !== null &&
      !(reference.allowsRoute && knownRoutes.has(normalizedRoutePath(path))) &&
      !knownAssets.has(path)
    ) {
      findings.push(
        `link.internal: ${reference.value} no resuelve a un destino aprobado`,
      );
    }
  }

  if (plan.selectedMode !== "blocks") {
    const ids = new Set(
      [...source.matchAll(/\bid\s*=\s*(["'])(.*?)\1/giu)].map(
        (match) => match[2] ?? "",
      ),
    );
    for (const link of routeLinks) {
      if (
        link.kind !== "href" ||
        !link.value.startsWith("#") ||
        link.value.length === 1
      ) {
        continue;
      }
      if (!ids.has(link.value.slice(1))) {
        findings.push(
          `link.fragment: ${link.value} no identifica un destino en la ruta`,
        );
      }
    }
  }
  return findings;
}
