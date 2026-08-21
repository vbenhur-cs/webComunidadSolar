export type LegacyRedirect = {
  from: string;
  to: string;
  group:
    | "empresa"
    | "autoconsumo-remoto"
    | "proyectos-remotos"
    | "comunidades"
    | "propietarios"
    | "servicios"
    | "contenidos";
};

/**
 * Mapa único de URLs públicas sustituidas durante la migración desde WordPress.
 *
 * Solo contiene rutas cuyo destino nuevo ya está publicado. Los destinos aún
 * no construidos quedan inventariados más abajo como decisiones pendientes.
 */
export const legacyRedirects: LegacyRedirect[] = [
  // Empresa
  { from: "/mision", to: "/nosotros#mision", group: "empresa" },
  { from: "/mision-2", to: "/nosotros#mision", group: "empresa" },
  {
    from: "/nuestra-mision",
    to: "/nosotros#mision",
    group: "empresa",
  },
  {
    from: "/nuestro-plan",
    to: "/nosotros#nuestro-plan",
    group: "empresa",
  },
  {
    from: "/cs-en-los-medios-de-comunicacion",
    to: "/#medios",
    group: "empresa",
  },
  { from: "/partners-y-empleo", to: "/nosotros", group: "empresa" },
  { from: "/home-2", to: "/", group: "empresa" },
  { from: "/mapa-con-resenas", to: "/#opiniones", group: "empresa" },
  { from: "/el-toro-tv", to: "/#pruebas", group: "empresa" },
  {
    from: "/preguntas-frecuentes-app",
    to: "/soy-comunero",
    group: "empresa",
  },
  {
    from: "/programa-de-referidos-csp",
    to: "/soy-comunero",
    group: "empresa",
  },
  {
    from: "/mensaje-a-descendientes",
    to: "/blog/septimo-aniversario-capsula-del-tiempo",
    group: "empresa",
  },
  {
    from: "/app-asistente-energetico",
    to: "/soy-comunero",
    group: "empresa",
  },

  // Autoconsumo Remoto y antiguas variantes comerciales
  { from: "/remoto", to: "/autoconsumo-remoto", group: "autoconsumo-remoto" },
  { from: "/a-remoto", to: "/autoconsumo-remoto", group: "autoconsumo-remoto" },
  { from: "/arv2", to: "/autoconsumo-remoto", group: "autoconsumo-remoto" },
  {
    from: "/prueba-autoconsumo-remoto",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-portal-renovables",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/vimart-gt-autoconsumo-remoto-con-baterias",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-megapark",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-v2",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-con-baterias",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-con-baterias-v2",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto-con-baterias-calculadora",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/que-es-autoconsumo-remoto-como-funciona",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/preguntas-frecuentes",
    to: "/contacto",
    group: "empresa",
  },
  {
    from: "/autoconsumo-remoto/b2c-calculadora",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto/b2c-formulario",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/autoconsumo-remoto/b2b-formulario",
    to: "/rentabiliza-tu-activo#solicitar-estudio",
    group: "propietarios",
  },
  {
    from: "/calcula-tu-ahorro",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/pack-ahorro-energetico-autoconsumo-baterias-pack_ar",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/pack-ahorro-energetico-autoconsumo-baterias-pack_ar_canadian_lp",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/pack-ahorro-energetico-autoconsumo-baterias-b2b",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },
  {
    from: "/pack-ahorro-energetico-b2b-crealsa",
    to: "/autoconsumo-remoto",
    group: "autoconsumo-remoto",
  },

  // Fichas históricas de activos remotos
  {
    from: "/proyecto-torrontera",
    to: "/autoconsumo-remoto/torrontera",
    group: "proyectos-remotos",
  },
  {
    from: "/proyecto-torrontera-configurador",
    to: "/autoconsumo-remoto/torrontera",
    group: "proyectos-remotos",
  },
  {
    from: "/megapark-fuente-alamo",
    to: "/autoconsumo-remoto/fuente-alamo",
    group: "proyectos-remotos",
  },
  {
    from: "/megapark-las-vegas",
    to: "/autoconsumo-remoto/torrontera",
    group: "proyectos-remotos",
  },
  {
    from: "/megapark-pisuerga",
    to: "/autoconsumo-remoto/liguerzana",
    group: "proyectos-remotos",
  },
  {
    from: "/autoconsumo-remoto/pisuerga",
    to: "/autoconsumo-remoto/liguerzana",
    group: "proyectos-remotos",
  },
  {
    from: "/reserva-megapark-talavera-eolico",
    to: "/autoconsumo-remoto",
    group: "proyectos-remotos",
  },
  {
    from: "/megapark-talavera-eolico",
    to: "/autoconsumo-remoto",
    group: "proyectos-remotos",
  },

  // Comunidades energéticas
  {
    from: "/comunidades-energeticas-v2",
    to: "/comunidades-energeticas",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-de-mi-edificio",
    to: "/comunidades-energeticas",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-villaverde",
    to: "/comunidades-energeticas/villaverde-getafe",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-nuevo-baztan",
    to: "/comunidades-energeticas/nuevo-baztan",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-nuevo-baztan-v2",
    to: "/comunidades-energeticas/nuevo-baztan",
    group: "comunidades",
  },
  {
    from: "/ce-ceuti",
    to: "/comunidades-energeticas/ceuti",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-villalbilla-madrid",
    to: "/comunidades-energeticas/villalbilla",
    group: "comunidades",
  },
  {
    from: "/ce-villalbilla-v2",
    to: "/comunidades-energeticas/villalbilla",
    group: "comunidades",
  },
  {
    from: "/ce-villalbilla-test",
    to: "/comunidades-energeticas/villalbilla",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-ibeas-de-juarros",
    to: "/comunidades-energeticas/ibeas-de-juarros",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-ibeas-de-juarros-v2",
    to: "/comunidades-energeticas/ibeas-de-juarros",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-san-adrian-de-juarros",
    to: "/comunidades-energeticas/san-adrian-de-juarros",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-san-adrian-de-juarros-v2",
    to: "/comunidades-energeticas/san-adrian-de-juarros",
    group: "comunidades",
  },
  {
    from: "/ce-sepulveda",
    to: "/comunidades-energeticas/sepulveda",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-de-mi-pueblo",
    to: "/comunidades-energeticas",
    group: "comunidades",
  },
  {
    from: "/santa-cruz-de-paniagua",
    to: "/comunidades-energeticas/santa-cruz-de-paniagua",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-ontinyent",
    to: "/comunidades-energeticas/ontinyent",
    group: "comunidades",
  },
  {
    from: "/comunidad-energetica-extremadura",
    to: "/comunidades-energeticas/extremadura",
    group: "comunidades",
  },

  // Propietarios de cubiertas y plantas
  {
    from: "/anfitrion-solar",
    to: "/rentabiliza-tu-activo#cubierta",
    group: "propietarios",
  },
  {
    from: "/anfitrion-solar-v2",
    to: "/rentabiliza-tu-activo#cubierta",
    group: "propietarios",
  },
  {
    from: "/instala-con-nosotros",
    to: "/rentabiliza-tu-activo",
    group: "propietarios",
  },
  {
    from: "/prueba-tejados-en-red",
    to: "/rentabiliza-tu-activo",
    group: "propietarios",
  },

  // Servicios ya reconstruidos
  {
    from: "/tarifas",
    to: "/comercializadora-y-tarifas",
    group: "servicios",
  },
  {
    from: "/mantenimiento-placas-solares",
    to: "/mantenimiento",
    group: "servicios",
  },
  {
    from: "/autoconsumo-en-mi-tejado-v2",
    to: "/autoconsumo-en-mi-tejado",
    group: "servicios",
  },
  {
    from: "/oferta-baterias-huawei",
    to: "/baterias",
    group: "servicios",
  },
  {
    from: "/oferta-baterias-solax-x1-ies",
    to: "/baterias#solax-x1-ies",
    group: "servicios",
  },
  {
    from: "/oferta-baterias-ecoflow-powerocean-con-instalacion-fotovoltaica",
    to: "/baterias",
    group: "servicios",
  },
  {
    from: "/respaldo-sin-placas",
    to: "/baterias#preguntas",
    group: "servicios",
  },
  {
    from: "/apagon-energetico",
    to: "/baterias#preguntas",
    group: "servicios",
  },
  {
    from: "/compra-grupo-aerotermia",
    to: "/aerotermia",
    group: "servicios",
  },
  {
    from: "/aerotermia-comunidad-solarcoolfy",
    to: "/aerotermia",
    group: "servicios",
  },

  // Contenidos históricos sustituidos por páginas de referencia más completas
  {
    from: "/blog/autoconsumo-remoto-de-comunidad-solar",
    to: "/autoconsumo-remoto",
    group: "contenidos",
  },
  {
    from: "/blog/ventajas-autoconsumo-remoto-energia-solar",
    to: "/autoconsumo-remoto",
    group: "contenidos",
  },
  {
    from: "/blog/autoconsumo-remoto-baterias-independencia-energetica",
    to: "/autoconsumo-remoto",
    group: "contenidos",
  },
  {
    from: "/blog/que-son-comunidades-energeticas",
    to: "/comunidades-energeticas",
    group: "contenidos",
  },
  {
    from: "/blog/como-crear-comunidad-energetica-area",
    to: "/rentabiliza-tu-activo",
    group: "contenidos",
  },
  {
    from: "/blog/como-comunidades-energeticas-reducir-costos",
    to: "/comunidades-energeticas",
    group: "contenidos",
  },
  {
    from: "/blog/ventajas-comunidades-energeticas",
    to: "/comunidades-energeticas",
    group: "contenidos",
  },
  {
    from: "/blog/autoconsumo-colectivo-y-comunidades-energeticas",
    to: "/comunidades-energeticas",
    group: "contenidos",
  },
  {
    from: "/blog/novedad-comunidad-energetica-nuevo-baztan",
    to: "/blog/nace-la-comunidad-de-nuevo-baztan",
    group: "contenidos",
  },
  {
    from: "/blog/que-hacer-excedentes-paneles-solares",
    to: "/comercializadora-y-tarifas#monedero",
    group: "contenidos",
  },
  {
    from: "/blog/consejos-mantenimiento-paneles-solares",
    to: "/mantenimiento",
    group: "contenidos",
  },
  {
    from: "/blog/aerotermia-la-revolucion-energetica-para-una-vida-sostenible",
    to: "/aerotermia#encaje",
    group: "contenidos",
  },
  {
    from: "/blog/elegir-bateria-luna2000-huawei",
    to: "/baterias#como-elegir",
    group: "contenidos",
  },
  {
    from: "/blog/baterias-solucion-cargas-criticas-cortes-energia",
    to: "/baterias#preguntas",
    group: "contenidos",
  },
  {
    from: "/blog/tipos-baterias-placas-solares",
    to: "/baterias#como-elegir",
    group: "contenidos",
  },
  {
    from: "/blog/energia-solar-merece-pena-instalar-baterias",
    to: "/baterias",
    group: "contenidos",
  },
  {
    from: "/blog/mitos-realidades-placas-solares",
    to: "/autoconsumo-en-mi-tejado#preguntas",
    group: "contenidos",
  },
  {
    from: "/blog/cuando-ampliar-instalacion-placas-solares",
    to: "/autoconsumo-en-mi-tejado#como-lo-hacemos",
    group: "contenidos",
  },
  {
    from: "/blog/guia-instalar-paneles-solares",
    to: "/autoconsumo-en-mi-tejado",
    group: "contenidos",
  },
  {
    from: "/blog/instalar-paneles-solares-aumenta-valor-propiedad",
    to: "/autoconsumo-en-mi-tejado",
    group: "contenidos",
  },
  {
    from: "/blog/paneles-solares-energia-solar-sostenible",
    to: "/autoconsumo-en-mi-tejado",
    group: "contenidos",
  },
  {
    from: "/blog/elegir-mejores-placas-solares",
    to: "/autoconsumo-en-mi-tejado#como-lo-hacemos",
    group: "contenidos",
  },
  {
    from: "/blog/ahorro-energetico",
    to: "/comercializadora-y-tarifas",
    group: "contenidos",
  },
  {
    from: "/blog/category/autoconsumo-remoto",
    to: "/autoconsumo-remoto",
    group: "contenidos",
  },
  {
    from: "/blog/category/comunidades-energeticas",
    to: "/comunidades-energeticas",
    group: "contenidos",
  },
  {
    from: "/blog/category/sin-categoria",
    to: "/blog",
    group: "contenidos",
  },
  {
    from: "/blog/category/aerotermia",
    to: "/aerotermia",
    group: "contenidos",
  },
  {
    from: "/blog/category/autoconsumo-en-casa",
    to: "/autoconsumo-en-mi-tejado",
    group: "contenidos",
  },
  {
    from: "/blog/category/baterias",
    to: "/baterias",
    group: "contenidos",
  },
];

const redirectsByPath = new Map(
  legacyRedirects.map((redirect) => [redirect.from, redirect.to]),
);

export function normalizeLegacyPath(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "").toLowerCase();
}

export function getLegacyRedirect(pathname: string) {
  return redirectsByPath.get(normalizeLegacyPath(pathname));
}

/**
 * URLs históricas sin un proyecto vigente al que trasladar al visitante.
 * Se sirven como 410 para que buscadores las retiren sin falsear su destino.
 */
export const legacyGonePaths = [
  "/comunidad-energetica-robregordo",
  "/megapark-serracin",
  "/invierte-en-comunidad-solar",
  "/aerotermia-confirmacion-formulario",
  "/prueba-los-belo",
  "/cs-wellsport",
  "/subvenciones",
  "/gestionamos-subvenciones",
  "/gestionamos-subvenciones-placas-solares",
  "/cargador-de-coche-electrico",
  "/blog/elementor-hf/footer-contacto",
  "/blog/elementor-hf/footer",
  "/blog/elementor-hf/menu-reducido-al-maximo",
  "/blog/elementor-hf/menu-simplificado",
  "/blog/elementor-hf/menu-hidden",
  "/blog/elementor-hf/header-solo-logo-fondo-beige",
  "/blog/elementor-hf/header-solo-logo",
  "/blog/elementor-hf/14157",
  "/blog/elementor-hf/menu-principal",
] as const;

const gonePaths = new Set<string>(legacyGonePaths);
const gonePrefixes = ["/blog/elementor-hf/"] as const;

export function isLegacyGonePath(pathname: string) {
  const normalizedPath = normalizeLegacyPath(pathname);
  return (
    gonePaths.has(normalizedPath) ||
    gonePrefixes.some((prefix) => normalizedPath.startsWith(prefix))
  );
}

/**
 * Decisiones pendientes que forman parte del inventario, pero no deben
 * convertirse en redirecciones hasta confirmar su madurez en Generaciones.
 */
export const legacyRoutesPendingDecision = [
  {
    path: "/sing-form-redireccionamiento-de-firma",
    decision: "Confirmar con Desarrollo que Zoho ya no utiliza esta ruta",
  },
  {
    path: "/ce-villanueva-de-guadamejud-v2",
    decision: "Validar en CRM si el proyecto sigue activo y publicable",
  },
] as const;

/**
 * Rutas del WordPress que ya tienen sustituto nativo con la misma URL.
 */
export const legacyPreservedPaths = [
  "/",
  "/blog",
  "/autoconsumo-remoto",
  "/comunidades-energeticas",
  "/autoconsumo-en-mi-tejado",
  "/comunidades-energeticas-operativas",
  "/nosotros",
  "/contacto",
  "/politica-privacidad",
  "/cookies",
  "/aviso-legal",
  "/terminos-y-condiciones",
] as const;

/**
 * Foto fija del sitemap público de WordPress auditado en julio de 2026.
 * Cada una de estas 122 rutas debe aparecer exactamente en una de las cuatro
 * categorías anteriores: redirección, retirada, pendiente o preservada.
 */
export const legacyWordPressSitemapPaths = [
  "/blog/category/aerotermia",
  "/blog/category/autoconsumo-en-casa",
  "/blog/category/autoconsumo-remoto",
  "/blog/category/baterias",
  "/blog/category/comunidades-energeticas",
  "/blog/category/sin-categoria",
  "/autoconsumo-remoto-megapark",
  "/blog/elementor-hf/footer-contacto",
  "/blog/elementor-hf/footer",
  "/blog/elementor-hf/menu-reducido-al-maximo",
  "/blog/elementor-hf/menu-simplificado",
  "/blog/elementor-hf/menu-hidden",
  "/blog/elementor-hf/header-solo-logo-fondo-beige",
  "/blog/elementor-hf/header-solo-logo",
  "/blog/elementor-hf/14157",
  "/blog/elementor-hf/menu-principal",
  "/",
  "/partners-y-empleo",
  "/nuestro-plan",
  "/el-toro-tv",
  "/sing-form-redireccionamiento-de-firma",
  "/mapa-con-resenas",
  "/megapark-serracin",
  "/preguntas-frecuentes-app",
  "/mision-2",
  "/reserva-megapark-talavera-eolico",
  "/comunidad-energetica-de-mi-edificio",
  "/mision",
  "/megapark-pisuerga",
  "/blog",
  "/que-es-autoconsumo-remoto-como-funciona",
  "/instala-con-nosotros",
  "/autoconsumo-remoto-con-baterias-calculadora",
  "/autoconsumo-en-mi-tejado-v2",
  "/comunidades-energeticas-v2",
  "/arv2",
  "/comunidad-energetica-nuevo-baztan-v2",
  "/ce-villalbilla-v2",
  "/ce-villalbilla-test",
  "/invierte-en-comunidad-solar",
  "/ce-villanueva-de-guadamejud-v2",
  "/a-remoto",
  "/vimart-gt-autoconsumo-remoto-con-baterias",
  "/apagon-energetico",
  "/nuestra-mision",
  "/home-2",
  "/mensaje-a-descendientes",
  "/oferta-baterias-huawei",
  "/calcula-tu-ahorro",
  "/compra-grupo-aerotermia",
  "/gestionamos-subvenciones-placas-solares",
  "/megapark-fuente-alamo",
  "/preguntas-frecuentes",
  "/cs-en-los-medios-de-comunicacion",
  "/autoconsumo-remoto/b2c-calculadora",
  "/autoconsumo-remoto/b2c-formulario",
  "/autoconsumo-remoto/b2b-formulario",
  "/anfitrion-solar-v2",
  "/pack-ahorro-energetico-autoconsumo-baterias-pack_ar",
  "/pack-ahorro-energetico-autoconsumo-baterias-pack_ar_canadian_lp",
  "/pack-ahorro-energetico-autoconsumo-baterias-b2b",
  "/oferta-baterias-ecoflow-powerocean-con-instalacion-fotovoltaica",
  "/respaldo-sin-placas",
  "/pack-ahorro-energetico-b2b-crealsa",
  "/cs-wellsport",
  "/comunidad-energetica-ibeas-de-juarros-v2",
  "/comunidad-energetica-san-adrian-de-juarros-v2",
  "/programa-de-referidos-csp",
  "/comunidad-energetica-ontinyent",
  "/comunidad-energetica-ibeas-de-juarros",
  "/comunidad-energetica-nuevo-baztan",
  "/comunidad-energetica-san-adrian-de-juarros",
  "/comunidad-energetica-villalbilla-madrid",
  "/cargador-de-coche-electrico",
  "/anfitrion-solar",
  "/tarifas",
  "/app-asistente-energetico",
  "/nosotros",
  "/contacto",
  "/santa-cruz-de-paniagua",
  "/autoconsumo-en-mi-tejado",
  "/ce-ceuti",
  "/oferta-baterias-solax-x1-ies",
  "/aerotermia-confirmacion-formulario",
  "/comunidad-energetica-extremadura",
  "/autoconsumo-remoto-portal-renovables",
  "/comunidad-energetica-villaverde",
  "/comunidades-energeticas",
  "/autoconsumo-remoto-con-baterias",
  "/autoconsumo-remoto-con-baterias-v2",
  "/proyecto-torrontera-configurador",
  "/aerotermia-comunidad-solarcoolfy",
  "/autoconsumo-remoto",
  "/proyecto-torrontera",
  "/comunidades-energeticas-operativas",
  "/prueba-los-belo",
  "/prueba-tejados-en-red",
  "/mantenimiento-placas-solares",
  "/prueba-autoconsumo-remoto",
  "/blog/autoconsumo-colectivo-y-comunidades-energeticas",
  "/blog/aerotermia-la-revolucion-energetica-para-una-vida-sostenible",
  "/blog/ventajas-comunidades-energeticas",
  "/blog/que-son-comunidades-energeticas",
  "/blog/novedad-comunidad-energetica-nuevo-baztan",
  "/blog/elegir-bateria-luna2000-huawei",
  "/blog/baterias-solucion-cargas-criticas-cortes-energia",
  "/blog/tipos-baterias-placas-solares",
  "/blog/consejos-mantenimiento-paneles-solares",
  "/blog/energia-solar-merece-pena-instalar-baterias",
  "/blog/mitos-realidades-placas-solares",
  "/blog/cuando-ampliar-instalacion-placas-solares",
  "/blog/guia-instalar-paneles-solares",
  "/blog/que-hacer-excedentes-paneles-solares",
  "/blog/como-comunidades-energeticas-reducir-costos",
  "/blog/instalar-paneles-solares-aumenta-valor-propiedad",
  "/blog/paneles-solares-energia-solar-sostenible",
  "/blog/ahorro-energetico",
  "/blog/autoconsumo-remoto-de-comunidad-solar",
  "/blog/ventajas-autoconsumo-remoto-energia-solar",
  "/blog/autoconsumo-remoto-baterias-independencia-energetica",
  "/blog/como-crear-comunidad-energetica-area",
  "/blog/elegir-mejores-placas-solares",
] as const;
