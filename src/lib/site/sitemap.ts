import { blogPosts } from "../../content/blog-runtime.ts";
import { communityPages } from "../../content/community-data.ts";
import { remoteProjects } from "../../content/remote-project-data.ts";
import { siteUrl } from "../seo/metadata.ts";

export type SitemapChangeFrequency = "weekly" | "monthly" | "yearly";

export interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency: SitemapChangeFrequency;
  priority: number;
}

export const coreSitemapRoutes = [
  "",
  "/nosotros",
  "/comunidades-energeticas",
  "/comunidades-energeticas/manganafer",
  "/autoconsumo-remoto",
  "/autoconsumo-en-mi-tejado",
  "/baterias",
  "/aerotermia",
  "/rentabiliza-tu-activo",
  "/comunidades-energeticas-operativas",
  "/comercializadora-y-tarifas",
  "/mantenimiento",
  "/soy-comunero",
  "/contacto",
  "/blog",
  "/eventos",
] as const;

export interface GeneratedSitemapMetadata {
  path: string;
  lastModified: string;
  changeFrequency: SitemapChangeFrequency;
  priority: number;
  privacy?: { private?: boolean };
  seo?: { index?: boolean };
}

type GeneratedModule = { default: unknown } | unknown;

const generatedMetadataModules =
  typeof import.meta.glob === "function"
    ? import.meta.glob("../../content/generated/*.json", {
        eager: true,
        import: "default",
      })
    : {};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isOptionalBooleanPolicy(
  value: unknown,
  field: "private" | "index",
): value is { private?: boolean; index?: boolean } {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (!(field in value) ||
        typeof (value as Record<string, unknown>)[field] === "boolean"))
  );
}

function isOriginLocalSitemapPath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    hasAsciiControlCharacter(path)
  ) {
    return false;
  }
  let decoded: string;
  let url: URL;
  try {
    decoded = decodeURIComponent(path);
    url = new URL(path, siteUrl);
  } catch {
    return false;
  }
  return (
    !hasAsciiControlCharacter(decoded) &&
    !decoded.split("/").includes("..") &&
    url.origin === new URL(siteUrl).origin &&
    url.pathname === path &&
    url.search === "" &&
    url.hash === ""
  );
}

export function isGeneratedSitemapMetadata(
  value: unknown,
): value is GeneratedSitemapMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.path === "string" &&
    isOriginLocalSitemapPath(metadata.path) &&
    typeof metadata.lastModified === "string" &&
    !Number.isNaN(Date.parse(metadata.lastModified)) &&
    (metadata.changeFrequency === "weekly" ||
      metadata.changeFrequency === "monthly" ||
      metadata.changeFrequency === "yearly") &&
    typeof metadata.priority === "number" &&
    Number.isFinite(metadata.priority) &&
    metadata.priority >= 0 &&
    metadata.priority <= 1 &&
    isOptionalBooleanPolicy(metadata.privacy, "private") &&
    isOptionalBooleanPolicy(metadata.seo, "index")
  );
}

function generatedSitemapValues(): unknown[] {
  const modules = generatedMetadataModules as Record<string, GeneratedModule>;
  return Object.entries(modules)
    .sort(([left], [right]) => compareText(left, right))
    .map(([, module]) =>
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : module,
    );
}

function generatedSitemapEntries(values: readonly unknown[]): SitemapEntry[] {
  return values.flatMap((metadata) => {
    if (!isGeneratedSitemapMetadata(metadata)) return [];
    if (metadata.privacy?.private === true || metadata.seo?.index === false) {
      return [];
    }
    return [
      {
        url: new URL(metadata.path, siteUrl).href,
        lastModified: new Date(metadata.lastModified),
        changeFrequency: metadata.changeFrequency,
        priority: metadata.priority,
      },
    ];
  });
}

export function buildSitemap(
  now: Date,
  generatedMetadata: readonly unknown[] = generatedSitemapValues(),
): SitemapEntry[] {
  const entries: SitemapEntry[] = [
    ...coreSitemapRoutes.map((route, index): SitemapEntry => ({
      url: new URL(route || "/", siteUrl).href.replace(/\/$/, route ? "" : ""),
      lastModified: now,
      changeFrequency: index === 0 ? "weekly" : "monthly",
      priority: index === 0 ? 1 : 0.8,
    })),
    ...communityPages.map((community) => ({
      url: new URL(`/comunidades-energeticas/${community.slug}`, siteUrl).href,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...remoteProjects.map((project) => ({
      url: new URL(`/autoconsumo-remoto/${project.slug}`, siteUrl).href,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...blogPosts.map((post) => ({
      url: new URL(`/blog/${post.slug}`, siteUrl).href,
      lastModified: new Date(post.date),
      changeFrequency: "yearly" as const,
      priority: post.featured ? 0.7 : 0.5,
    })),
    ...generatedSitemapEntries(generatedMetadata),
  ];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}
