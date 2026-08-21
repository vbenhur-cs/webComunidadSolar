export type HeaderPageKey =
  | "inicio"
  | "nosotros"
  | "remoto"
  | "comunidades"
  | "fotovoltaica"
  | "baterias"
  | "aerotermia"
  | "activos"
  | "activoConectado"
  | "blog"
  | "eventos"
  | "comunero"
  | "contacto"
  | "comercializadora"
  | "mantenimiento"
  | "privacy"
  | "cookies"
  | "legal"
  | "terms"
  | "socios"
  | "guia";

export const pageRegistry: Record<HeaderPageKey, { path: string }> = {
  inicio: { path: "/" },
  nosotros: { path: "/nosotros" },
  remoto: { path: "/autoconsumo-remoto" },
  comunidades: { path: "/comunidades-energeticas" },
  fotovoltaica: { path: "/autoconsumo-en-mi-tejado" },
  baterias: { path: "/baterias" },
  aerotermia: { path: "/aerotermia" },
  activos: { path: "/rentabiliza-tu-activo" },
  activoConectado: { path: "/comunidades-energeticas-operativas" },
  blog: { path: "/blog" },
  eventos: { path: "/eventos" },
  comunero: { path: "/soy-comunero" },
  contacto: { path: "/contacto" },
  comercializadora: { path: "/comercializadora-y-tarifas" },
  mantenimiento: { path: "/mantenimiento" },
  privacy: { path: "/politica-privacidad" },
  cookies: { path: "/cookies" },
  legal: { path: "/aviso-legal" },
  terms: { path: "/terminos-y-condiciones" },
  socios: { path: "/socios" },
  guia: { path: "/guia-equipo" },
};

export function isCurrentPageLink(page: HeaderPageKey, href: string): boolean {
  return pageRegistry[page].path === href.split("#")[0];
}
