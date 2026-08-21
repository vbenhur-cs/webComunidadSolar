export interface SiteMeta {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: { index: boolean; follow: boolean };
  openGraph: boolean;
}

export const siteUrl = "https://comunidadsolar.es";
export const defaultTitle =
  "Comunidad Solar | La energía vuelve a las personas";
export const titleTemplate = "%s | Comunidad Solar";
export const defaultDescription =
  "Comunidades energéticas de proximidad, almacenamiento y autoconsumo remoto para avanzar hacia tu independencia energética.";

export function completeSiteMeta(meta: Partial<SiteMeta> = {}): SiteMeta {
  const indexable = process.env.SITE_INDEXABLE === "true";
  return {
    title: meta.title ?? null,
    description: Object.hasOwn(meta, "description")
      ? (meta.description ?? null)
      : defaultDescription,
    canonical: meta.canonical === undefined ? "/" : meta.canonical,
    robots: meta.robots ?? { index: indexable, follow: indexable },
    openGraph: meta.openGraph ?? true,
  };
}

export function documentTitle(title: string | null): string {
  return title === null || title === ""
    ? defaultTitle
    : titleTemplate.replace("%s", title);
}

export function absoluteCanonical(path: string | null): string | null {
  return path === null ? null : new URL(path, siteUrl).href;
}

export function socialMetadata(metadata: SiteMeta): {
  title: string;
  description: string;
  url: string;
} {
  if (metadata.canonical === null) {
    return {
      title: defaultTitle,
      description: defaultDescription,
      url: new URL("/", siteUrl).href,
    };
  }

  return {
    title: metadata.title ?? defaultTitle,
    description: metadata.description ?? defaultDescription,
    url: new URL(metadata.canonical, siteUrl).href,
  };
}
