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
  nosotros: {
    path: "/nosotros",
    title: "Quiénes somos",
    description:
      "Conoce la historia, la misión y el movimiento #PorElPlaneta de Comunidad Solar: energía limpia, compartida y pensada para quienes vienen detrás.",
  },
  remoto: {
    path: "/autoconsumo-remoto",
    title: "Autoconsumo Remoto: tus paneles solares a distancia",
    description:
      "Elige tus paneles en una planta solar real y aprovecha durante 40 años la energía que producen. Sin tejado, sin obras y con almacenamiento en Torrontera.",
  },
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
  activos: {
    path: "/rentabiliza-tu-activo",
    title: "Rentabiliza tu activo",
    description:
      "Convierte tu cubierta o planta fotovoltaica en una comunidad energética con la gestión comercial y energética de Comunidad Solar.",
  },
  activoConectado: {
    path: "/comunidades-energeticas-operativas",
    title: "Convierte tu planta en una comunidad energética operativa",
    description:
      "Comunidad Solar aporta Helios, comercializadora, captación y operación para conectar plantas fotovoltaicas construidas con hogares y empresas de proximidad.",
  },
  blog: {
    path: "/blog",
    title: "Blog",
    description:
      "La vida real de Comunidad Solar: comuneros, visitas, eventos, proyectos y un archivo vivo desde 2018.",
  },
  eventos: {
    path: "/eventos",
    title: "Eventos y webinars",
    description:
      "Próximos encuentros y archivo de visitas, jornadas y webinars públicos de Comunidad Solar en Zoho Backstage y TrainerCentral.",
  },
  comunero: {
    path: "/soy-comunero",
    title: "Soy comunero",
    description:
      "Accede a la app Comunidad Solar o entra identificado en Atención al Comunero para consultar y seguir tus solicitudes.",
  },
  contacto: {
    path: "/contacto",
    title: "Contacto",
    description:
      "Habla con un asesor energético si estás decidiendo o entra directamente en los canales de atención si ya eres comunero.",
  },
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
  privacy: {
    path: "/politica-privacidad",
    title: "Política de privacidad",
    description:
      "Revisa nuestra política de privacidad sobre la recopilación y el consentimiento del uso de tus datos en nuestra web",
  },
  cookies: {
    path: "/cookies",
    title: "Política de cookies",
    description:
      "Esta página web usa cookies. Las cookies de este sitio web se usan para personalizar el contenido y los anuncios y analizar el tráfico.",
  },
  legal: {
    path: "/aviso-legal",
    title: "Aviso legal",
    description:
      "Revisa nuestro aviso legal sobre la descripción de la actividad, el uso de nuestra web y los servicios ofertados.",
  },
  terms: {
    path: "/terminos-y-condiciones",
    title: "Términos y condiciones",
    description:
      "Estos son nuestros términos y condiciones para el uso de nuestro sitio web y la compra de productos a través del sitio web.",
  },
  socios: { path: "/socios" },
  guia: { path: "/guia-equipo" },
};

export type CorePageKey =
  | "nosotros"
  | "remoto"
  | "comunidades"
  | "fotovoltaica"
  | "baterias"
  | "aerotermia"
  | "mantenimiento"
  | "comercializadora"
  | "blog"
  | "eventos"
  | "comunero"
  | "contacto"
  | "activos"
  | "activoConectado"
  | "privacy"
  | "cookies"
  | "legal"
  | "terms";

export type LegalPageKey = "privacy" | "cookies" | "legal" | "terms";

/** Native Astro page keys implemented so far; later tasks extend this map. */
export const corePageComponents: Record<CorePageKey, string> = {
  nosotros: "AboutPage",
  remoto: "RemotePage",
  comunidades: "CommunitiesPage",
  fotovoltaica: "SolarInstallationPage",
  baterias: "BatteriesPage",
  aerotermia: "AerothermalPage",
  mantenimiento: "MaintenancePage",
  comercializadora: "CommercializerPage",
  blog: "BlogPage",
  eventos: "EventsPage",
  comunero: "MemberPage",
  contacto: "ContactPage",
  activos: "AssetsPage",
  activoConectado: "OperationalAssetsPage",
  privacy: "LegalPage",
  cookies: "LegalPage",
  legal: "LegalPage",
  terms: "LegalPage",
};

export const staticSlugPaths = Object.keys(corePageComponents)
  .map((key) => pageRegistry[key as CorePageKey].path.slice(1))
  .sort();

export function isCorePageKey(key: HeaderPageKey): key is CorePageKey {
  return Object.hasOwn(corePageComponents, key);
}

export function isLegalPageKey(key: CorePageKey): key is LegalPageKey {
  return (
    key === "privacy" || key === "cookies" || key === "legal" || key === "terms"
  );
}

export function isCurrentPageLink(page: HeaderPageKey, href: string): boolean {
  return pageRegistry[page].path === href.split("#")[0];
}
