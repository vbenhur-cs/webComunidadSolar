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

export interface PageRegistryEntry {
  path: string;
  title?: string;
  description?: string;
}

export const pageRegistry: Record<HeaderPageKey, PageRegistryEntry> = {
  inicio: { path: "/" },
  nosotros: { path: "/nosotros" },
  remoto: { path: "/autoconsumo-remoto" },
  comunidades: {
    path: "/comunidades-energeticas",
    title: "Comunidades Energéticas",
    description:
      "Energía solar de proximidad en compra o alquiler, con soluciones para quien quiere invertir y para quien prefiere no hacerlo.",
  },
  fotovoltaica: {
    path: "/autoconsumo-en-mi-tejado",
    title: "Instalación fotovoltaica con batería valorada desde el diseño",
    description:
      "Instalación solar a medida según tu consumo y tu tejado. Comparamos placas solas y placas con batería antes de coordinar montaje, legalización y puesta en marcha.",
  },
  baterias: {
    path: "/baterias",
    title: "Batería doméstica SolaX con o sin placas solares",
    description:
      "Oferta SolaX X1-IES para viviendas con o sin paneles: inversor de 5 kW, batería de 5,1 kWh, respaldo, instalación y legalización.",
  },
  aerotermia: {
    path: "/aerotermia",
    title: "Aerotermia con Coolfy para viviendas",
    description:
      "Coolfy, instalador Premium y partner oficial de Comunidad Solar, estudia e instala tu solución de aerotermia de principio a fin.",
  },
  activos: { path: "/rentabiliza-tu-activo" },
  activoConectado: { path: "/comunidades-energeticas-operativas" },
  blog: { path: "/blog" },
  eventos: { path: "/eventos" },
  comunero: { path: "/soy-comunero" },
  contacto: { path: "/contacto" },
  comercializadora: {
    path: "/comercializadora-y-tarifas",
    title: "Comercializadora eléctrica para comuneros",
    description:
      "Tarifas Megapark y Megahome: energía de red a precio de coste, producción propia, excedentes en el monedero virtual y gestión desde la app.",
  },
  mantenimiento: {
    path: "/mantenimiento",
    title: "Mantenimiento fotovoltaico",
    description:
      "Servicio de mantenimiento fotovoltaico recomendado por Comunidad Solar, prestado y contratado directamente con Solaico.",
  },
  privacy: { path: "/politica-privacidad" },
  cookies: { path: "/cookies" },
  legal: { path: "/aviso-legal" },
  terms: { path: "/terminos-y-condiciones" },
  socios: { path: "/socios" },
  guia: { path: "/guia-equipo" },
};

export type CorePageKey =
  | "comunidades"
  | "fotovoltaica"
  | "baterias"
  | "aerotermia"
  | "mantenimiento"
  | "comercializadora";

/** Native Astro page keys implemented so far; later tasks extend this map. */
export const corePageComponents: Record<CorePageKey, string> = {
  comunidades: "CommunitiesPage",
  fotovoltaica: "SolarInstallationPage",
  baterias: "BatteriesPage",
  aerotermia: "AerothermalPage",
  mantenimiento: "MaintenancePage",
  comercializadora: "CommercializerPage",
};

export const staticSlugPaths = Object.keys(corePageComponents)
  .map((key) => pageRegistry[key as CorePageKey].path.slice(1))
  .sort();

export function isCorePageKey(key: HeaderPageKey): key is CorePageKey {
  return Object.hasOwn(corePageComponents, key);
}

export function isCurrentPageLink(page: HeaderPageKey, href: string): boolean {
  return pageRegistry[page].path === href.split("#")[0];
}
