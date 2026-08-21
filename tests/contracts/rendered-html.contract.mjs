import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

import {
  readMigratedSource,
  readProjectAsset,
} from "../helpers/read-migrated-source.ts";
import {
  closePreviewPool,
  requestPreview,
} from "../helpers/preview-pool.ts";

const contractScopes = JSON.parse(
  readFileSync(new URL("./contract-scope.json", import.meta.url), "utf8"),
);
const requestedContractScope = process.env.CONTRACT_SCOPE ?? "all";

function contractTest(name, callback) {
  const scope = contractScopes[name];
  if (scope !== "public" && scope !== "server") {
    throw new Error(`El contrato ${name} no tiene scope declarado`);
  }
  if (
    requestedContractScope !== "all" &&
    requestedContractScope !== scope
  ) {
    return test.skip(name, callback);
  }
  return test(name, callback);
}

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

const extremaduraLocationSlugs = [
  "almendralejo",
  "merida",
  "don-benito",
  "jerez-de-los-caballeros",
  "navalmoral-de-la-mata",
  "zafra",
  "caceres",
  "plasencia",
  "coria",
  "villafranca-de-los-barros",
];

const localCommunitySlugs = [
  "villaverde-getafe",
  "nuevo-baztan",
  "ceuti",
  "villalbilla",
  "ibeas-de-juarros",
  "san-adrian-de-juarros",
  "sepulveda",
  "santa-cruz-de-paniagua",
  "ontinyent",
  "escurial",
  ...extremaduraLocationSlugs,
];

const retiredExtremaduraOrganizations = /Copergie|Copergy|Settran/i;

async function renderPath(path = "/", options = {}) {
  return requestPreview(path, options);
}

after(async () => {
  await closePreviewPool();
});

function decodeLegalText(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function normalizeLegalHtml(title, fragment) {
  const text = fragment
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|li|ol|ul|blockquote|h[2-4])>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decodeLegalText(`${title} ${text}`).replace(/\s+/g, " ").trim();
}

contractTest("does not expose development preview metadata", async () => {
  const response = await renderPath();

  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), developmentPreviewMeta);
});

contractTest("publishes canonical and social metadata", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /rel="canonical" href="https:\/\/comunidadsolar\.es\/"/);
  assert.match(html, /property="og:site_name" content="Comunidad Solar"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});

contractTest("keeps option 1 in the home hero and reuses the corporate header", async () => {
  const response = await renderPath("/");
  const html = await response.text();
  const hero = html.match(
    /<section class="hero hero-home hero-home-option1"[\s\S]*?<\/section>/,
  )?.[0];

  assert.equal(response.status, 200);
  assert.ok(hero, "La home debe conservar un hero identificable");
  assert.match(hero, /La energía/);
  assert.match(hero, /<span>vuelve a manos<\/span>/);
  assert.match(hero, /<span>de las personas\.<\/span>/);
  assert.match(hero, /Produce energía cerca de ti, almacénala y elige si quieres/);
  assert.match(hero, /href="\/comunidades-energeticas#cobertura"/);
  assert.match(hero, /href="\/nosotros#nuestro-plan"/);
  assert.match(hero, /Más de 3\.500 personas y empresas/);
  assert.match(hero, /Independientes de grandes grupos/);
  assert.match(hero, /Compra o alquiler/);
  assert.match(hero, /Tres razones para confiar en Comunidad Solar/);
  assert.match(hero, /Comunidad Solar conecta comunidades energéticas en España/);
  assert.match(hero, /NUESTRA RED EN ESPAÑA/);
  assert.match(hero, /20 comunidades/);
  assert.match(hero, /Ver ubicación, estado y ficha/);
  assert.match(hero, /href="\/comunidades-energeticas#proyectos"/);
  assert.match(
    hero,
    /aria-label="Ver todas las comunidades energéticas de Comunidad Solar"/,
  );
  assert.doesNotMatch(hero, /Villalbilla/);
  assert.equal(
    (hero.match(/home-option1-territory-branch"/g) ?? []).length,
    3,
    "La ruta debe ramificarse por tres calles hacia varias viviendas",
  );
  assert.equal(
    (hero.match(/home-option1-territory-twig"/g) ?? []).length,
    9,
    "Los tres nodos del pueblo deben repartir energía hacia nueve viviendas",
  );
  assert.equal(
    (hero.match(/home-option1-territory-feeder"/g) ?? []).length,
    2,
    "La conexión desde la batería debe bordear el parque solar por sus dos lados",
  );
  assert.doesNotMatch(hero, /Castilla-La Mancha/);
  assert.doesNotMatch(hero, /1,2 MW · 320 comuneros/);
  assert.match(
    hero,
    /src="\/media\/home-hero-option-1-spain-connected-1024x792\.png"/,
  );
  assert.match(
    hero,
    /alt="Escena conceptual de un pueblo español conectado con producción solar y almacenamiento"/,
  );
  assert.match(html, /<header class="site-header">/);
  assert.match(html, /src="\/comunidad-solar-logo\.svg"/);
  assert.match(
    html,
    /class="header-cta">Comprueba tu cobertura <span aria-hidden="true">→<\/span>/,
  );
  assert.doesNotMatch(html, /comunidad-solar-logo-option-1\.svg/);
  assert.doesNotMatch(html, /site-header-option1/);
  assert.match(
    html,
    /class="topline-message"><i aria-hidden="true"><\/i>Energía independiente desde 2018<\/span>/,
  );
  assert.match(
    html,
    /class="topline-stat">La energía de las personas<\/span>/,
  );
  assert.ok(
    html.indexOf("home-option1-proof") < html.indexOf('class="trust-band '),
    "La opción 1 debe terminar antes de los módulos existentes de la home",
  );

  const asset = await readProjectAsset(
    "media/home-hero-option-1-spain-connected-1024x792.png",
  );
  assert.ok(asset.byteLength > 0);
});

contractTest("opens Nosotros with #PorElPlaneta, the real Damian film and the corporate header", async () => {
  const response = await renderPath("/nosotros");
  const html = await response.text();
  const hero = html.match(
    /<section class="about-hero"[\s\S]*?<\/section>/,
  )?.[0];

  assert.equal(response.status, 200);
  assert.ok(hero, "Nosotros debe conservar un hero específico e identificable");
  assert.match(hero, /data-about-video="1093023979"/);
  assert.match(hero, /#PorElPlaneta/);
  assert.match(
    hero,
    /La energía que elegimos hoy cambia el mundo que dejamos mañana\./,
  );
  assert.match(hero, /Damián Villa/);
  assert.match(hero, /Comunero desde 2021/);
  assert.match(hero, /Hay decisiones que/);
  assert.match(hero, /iluminan el futuro/);
  assert.match(hero, /src="\/media\/damian-villa-por-el-planeta\.jpg"/);
  assert.match(hero, /href="#historia"/);
  assert.match(hero, />Ver el vídeo<\/span>/);
  assert.match(html, /<header class="site-header">/);
  assert.match(html, /src="\/comunidad-solar-logo\.svg"/);
  assert.match(
    html,
    /class="topline-message"><i aria-hidden="true"><\/i>Energía independiente desde 2018<\/span>/,
  );
  assert.match(
    html,
    /class="topline-stat">La energía de las personas<\/span>/,
  );
  assert.doesNotMatch(html, /site-header-option1|site-header-option3/);
  assert.ok(
    html.indexOf('class="about-hero"') < html.indexOf('class="facts-section"'),
    "El relato #PorElPlaneta debe abrir la página antes de las cifras",
  );
  assert.match(
    html,
    /Construir un mundo mejor también es una decisión energética\./,
  );

  const poster = await readProjectAsset("media/damian-villa-por-el-planeta.jpg");
  assert.ok(poster.byteLength > 0);
});

contractTest("renders sourced trust evidence on the home page", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Más de 400 reseñas en Google/);
  assert.match(html, /comercializadora inscrita en la CNMC/);
  assert.match(html, /Historias recientes del archivo/);
  assert.match(html, /Comunidad Solar Power, S\.L\./);
  assert.doesNotMatch(html, /405 reseñas en Google/);
});

contractTest("shows the real Villalbilla roof as the home energy-community proof", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /src="\/media\/villalbilla-gregorio-canella-cubierta\.jpg"/,
  );
  assert.match(
    html,
    /alt="Paneles solares en la cubierta del colegio Gregorio Canella de Villalbilla"/,
  );
  assert.match(html, /Villalbilla · Madrid/);
  assert.match(html, /La planta de Villalbilla está conectada a la red desde 2025/);
  assert.match(html, /Desde julio de 2026/);
  assert.match(
    html,
    /href="\/comunidades-energeticas\/villalbilla"/,
  );
});

contractTest("separates plant connection from energy shown on member bills", async () => {
  const villalbilla = await renderPath(
    "/comunidades-energeticas/villalbilla",
  );
  const villalbillaHtml = await villalbilla.text();

  assert.equal(villalbilla.status, 200);
  assert.match(villalbillaHtml, /Conectada a la red desde 2025/);
  assert.match(villalbillaHtml, /Energía en factura/);
  assert.match(
    villalbillaHtml,
    /Energía reflejada en las primeras facturas/,
  );
  assert.doesNotMatch(
    villalbillaHtml,
    /pendiente del contador definitivo|para comenzar a generar/,
  );

  const getafe = await renderPath(
    "/comunidades-energeticas/villaverde-getafe",
  );
  const getafeHtml = await getafe.text();

  assert.equal(getafe.status, 200);
  assert.match(getafeHtml, /La planta está conectada, pero los comuneros aún no reciben la energía/);
  assert.match(getafeHtml, /Los comuneros aún no reciben energía en factura/);
  assert.match(
    getafeHtml,
    /legalización de los coeficientes de reparto/,
  );
  assert.doesNotMatch(
    getafeHtml,
    /Primeros suministros activados|ya reciben producción asignada/,
  );
});

contractTest("uses one public label for the five-kilometre radius", async () => {
  for (const path of ["/", "/comunidades-energeticas"]) {
    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Hasta 5 km/);
    assert.doesNotMatch(html, /A menos de 5 km|≤\s*5 km/);
  }
});

contractTest("limits the Manganáfer campaign to one kilometre with an accessible local map", async () => {
  const response = await renderPath(
    "/comunidades-energeticas/manganafer",
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /<meta name="description" content="Si forma parte de tu paisaje, también debería formar parte de tus beneficios\."/,
  );
  assert.match(
    html,
    /<meta property="og:description" content="Si forma parte de tu paisaje, también debería formar parte de tus beneficios\."/,
  );
  assert.match(
    html,
    /<meta name="twitter:description" content="Si forma parte de tu paisaje, también debería formar parte de tus beneficios\."/,
  );
  assert.match(html, /Máximo 1 km/);
  assert.match(html, /máximo de 1 kilómetro/);
  assert.doesNotMatch(html, /500\s*(?:m|metros)/i);
  assert.doesNotMatch(html, /radio (?:habitual|general) de hasta 5 km/i);
  assert.match(
    html,
    /Esta propuesta está reservada a hogares y pequeños negocios\s+situados a un máximo de 1 kilómetro de Manganáfer/,
  );
  assert.match(
    html,
    /si el\s+parque forma parte de tu entorno, sus beneficios también deben\s+llegar hasta ti/,
  );
  assert.match(html, /Mapa orientativo/);
  assert.match(
    html,
    /Zona de proximidad de la Comunidad Energética de Manganáfer/,
  );
  assert.match(
    html,
    /La\s+distancia y la elegibilidad se confirmarán con el CUPS/,
  );
  assert.match(html, /ÁREA MÁXIMA · 1 km/);
  assert.doesNotMatch(html, /[?&]cups=/i);

  const communitiesResponse = await renderPath("/comunidades-energeticas");
  const communitiesHtml = await communitiesResponse.text();
  assert.equal(communitiesResponse.status, 200);
  assert.match(communitiesHtml, /Cartagena · ámbito local de hasta 1 km/);

  const quoteRouteSource = await readMigratedSource("quote");
  assert.match(quoteRouteSource, /maximumCoverageMetres\s*=\s*1_000/);

  const calculatorResponse = await renderPath(
    "/comunidades-energeticas/manganafer",
    {
      env: {
        MANGANAFER_QUOTING_BEARER_TOKEN: "test-token",
        MANGANAFER_PANEL_MONTHLY_FEE: "7.4",
        MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT: "6.1157",
        MANGANAFER_PANEL_FEE_VAT: "0.21",
        MANGANAFER_AVAILABLE_PANELS: "100",
        MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH: "900",
        MANGANAFER_DISCOUNT: "0.5",
        MANGANAFER_PANEL_POWER_W: "540",
        MANGANAFER_ANNUAL_DEGRADATION: "0.0045",
      },
    },
  );
  const calculatorHtml = await calculatorResponse.text();

  assert.equal(calculatorResponse.status, 200);
  assert.match(calculatorHtml, /Calcular con mi CUPS/);
  assert.match(calculatorHtml, /Introduce tu CUPS y descubre cómo podría quedar tu ahorro/);
  assert.match(calculatorHtml, /id="manganafer-cups"/);
  assert.match(calculatorHtml, /action="\/api\/manganafer-quote"|manganafer-calculator-form/);
  assert.match(calculatorHtml, /No lo guardamos ni lo\s+enviamos a analítica/);
  assert.match(calculatorHtml, /manganafer_calculator_hero/);
  assert.doesNotMatch(calculatorHtml, /[?&]cups=/i);
  assert.doesNotMatch(calculatorHtml, /test-token/);
});

contractTest("validates Manganáfer CUPS server-side without caching or exposing it", async () => {
  const invalid = await renderPath("/api/manganafer-quote", {
    method: "POST",
    body: JSON.stringify({ cups: "ES123" }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
  });
  const invalidBody = await invalid.json();

  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.field, "cups");
  assert.match(invalidBody.error, /debe empezar por ES/);
  assert.match(invalid.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(invalid.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    invalid.headers.get("x-robots-tag") ?? "",
    /noindex, nofollow/,
  );

  const unavailable = await renderPath("/api/manganafer-quote", {
    method: "POST",
    body: JSON.stringify({ cups: "ES1234567890123456AB" }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
  });
  const unavailableBody = await unavailable.json();

  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(JSON.stringify(unavailableBody), /ES1234567890123456AB/);
});

contractTest("explains remote autoconsumption with a panel-led, contract-aligned story", async () => {
  const response = await renderPath("/autoconsumo-remoto");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Tus paneles solares no tienen que estar en tu tejado/);
  assert.match(html, /href="https:\/\/presupuesto-ar\.comunidadsolar\.es"/);
  assert.match(html, /data-analytics-event="remote_calculator_open"/);
  assert.match(
    html,
    /Elige los paneles de una planta solar real/,
  );
  assert.match(html, /Tus paneles están a distancia\. Su energía trabaja para ti/);
  assert.match(html, /Eliges tus paneles a distancia/);
  assert.match(html, /Jurídicamente contratas por adelantado la energía/);
  assert.match(html, /La red hace de puente/);
  assert.match(html, /Torrontera ya está produciendo/);
  assert.match(html, /UNA OFERTA, UN CONTRATO CONCRETO/);
  assert.match(html, /Tu documentación identifica una sola instalación/);
  assert.match(html, /40[\s\S]{0,80}AÑOS · TORRONTERA/);
  assert.match(html, /tranquilidad durante 40 años/);
  assert.match(html, /data-bill-example="true"/);
  assert.match(html, /Venta horaria neta · importe ilustrativo/);
  assert.match(html, /1 € \+ IVA por panel y mes/);
  assert.match(html, /3 € \+ IVA al mes de cuota Comunidad Solar/);
  assert.match(html, /El suministro no tiene permanencia/);
  assert.match(html, /Puedes ceder el contrato a otra persona/);
  assert.match(html, /No significa una factura total de 0 €/);
  assert.match(html, /data-remote-hero-video="1145233162"/);
  assert.match(
    html,
    /src="\/media\/cs-medios-2025-poster-antena3\.jpg"/,
  );
  assert.match(
    html,
    /aria-label="Reproducir el reel de apariciones de Comunidad Solar en televisión"/,
  );
  assert.ok(
    html.indexOf('data-remote-hero-video="1145233162"') <
      html.indexOf('class="facts-section"'),
    "the media reel should appear in the hero before the facts section",
  );
  assert.doesNotMatch(html, /data-remote-video="1145233162"/);
  assert.match(html, /data-remote-video="reqBqJBFQIk"/);
  assert.match(html, /data-remote-video="1108990443"/);
  assert.doesNotMatch(html, /data-remote-video="-JCQOrxcbh4"/);
  assert.doesNotMatch(html, /data-remote-video="U-503rebaQM"/);
  assert.match(html, /Torrontera I y II/);
  assert.match(html, /Fuente Álamo I y II/);
  assert.match(html, /Ligüérzana/);
  assert.match(
    html,
    /90 % del proyecto ya está contratado · dato revisado en julio de 2026/,
  );
  assert.match(html, /Sin plazas disponibles para nuevas incorporaciones/);
  assert.match(html, /Cuántos paneles pondrías bajo el sol para ti/);
  assert.doesNotMatch(html, /Mazarrón/);
  assert.doesNotMatch(html, /asociar(?:la)? a otro suministro/i);
  assert.doesNotMatch(html, /la página explica el modelo general/i);
  assert.doesNotMatch(html, /debes revisar|el documento debe concretar/i);
  assert.doesNotMatch(html, /Disponibilidad comercial/);
  assert.doesNotMatch(html, /El remoto también evoluciona con el mercado/);
  assert.doesNotMatch(html, /Los pioneros pueden ayudarnos/);
  assert.doesNotMatch(html, /La antigua ficha Megapark/);

  const orderedMarkers = [
    'id="como-funciona"',
    'id="torrontera"',
    'class="remote-long-term-band"',
    "remote-bill-section",
    'id="seguridad"',
    'id="proyectos"',
  ];
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const currentIndex = html.indexOf(marker);
    assert.ok(currentIndex > previousIndex, `${marker} debe respetar el relato`);
    previousIndex = currentIndex;
  }
});

contractTest("renders the native commercializer and tariffs page", async () => {
  const response = await renderPath("/comercializadora-y-tarifas");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /La comercializadora que conecta tu suministro con Comunidad Solar/,
  );
  assert.match(
    html,
    /Dos tarifas con dos recorridos claramente distintos/,
  );
  assert.match(html, /Tarifa Megapark/);
  assert.match(html, /Tarifa Megahome/);
  assert.match(html, /3 €[\s\S]{0,80}al mes/);
  assert.match(html, /5 €[\s\S]{0,80}al mes/);
  assert.match(html, /Megapark no es un producto independiente/);
  assert.match(html, /No se contrata por separado/);
  assert.match(html, /Este formulario no contrata Megapark/);
  assert.match(html, /Remoto o Comunidad Energética/);
  assert.match(html, /código de invitación/);
  assert.match(html, /Tengo un código/);
  assert.match(
    html,
    /producción coincidente a 0 €\/kWh en el componente de energía/,
  );
  assert.match(html, /100 % del saldo reconocido a tus excedentes/);
  assert.match(
    html,
    /https:\/\/forms\.zohopublic\.eu\/comunidadsolar\/form\/Solicitarinscripcinsincompromisolistadeespera2\/formperma\/W2P0ThJSOGwxznpXQyEXmyF1gLZXILVvpwnMrn2JHms/,
  );
  assert.match(
    html,
    /https:\/\/calculadora-autoconsumo-remoto\.comunidadsolar\.es\/contratar\/megahome\/initial/,
  );
  assert.match(html, /data-analytics-event="megapark_information_open"/);
  assert.match(html, /data-analytics-event="megahome_signup_open"/);
  assert.match(html, /data-bill-example="true"/);
  assert.match(html, /Tu factura de la luz con Comunidad Solar/);
  assert.match(html, /Tu día, en tres colores/);
  assert.match(html, /Tu producción utilizada/);
  assert.match(html, /Energía de la red/);
  assert.match(html, /Producción no utilizada/);
  assert.match(html, /Total del ejemplo/);
  assert.match(html, /Ejemplo ilustrativo, no una oferta/);
  assert.doesNotMatch(html, /data-bill-simulator="true"/);
  assert.doesNotMatch(html, /type="range"/);
  assert.doesNotMatch(html, /Ajusta el ejemplo/);
  assert.match(html, /Ingebau/);
  assert.match(html, /monedero guarda saldo económico, no kilovatios hora/i);
  assert.match(html, /Una comercializadora que trabaja para la comunidad/);
  assert.match(html, /R2-883/);
  assert.doesNotMatch(html, /Contratar Megapark/);
  assert.doesNotMatch(html, /Tres formas distintas de llevar tu energía/);
  assert.doesNotMatch(html, /Tramitamos el reparto|coeficientes de reparto/);
  assert.doesNotMatch(html, /Comunidad Energética\.<\/h3>/);
  assert.doesNotMatch(html, /Comercializadora Regulada por la/);
});

contractTest("renders the Extremeña title once and omits retired organizations", async () => {
  const response = await renderPath(
    "/comunidades-energeticas/extremadura",
  );
  const html = await response.text();
  const visibleTitles =
    html.match(/<h1[^>]*>Comunidad Energética Extremeña<\/h1>/g) ?? [];

  assert.equal(response.status, 200);
  assert.equal(visibleTitles.length, 1);
  assert.doesNotMatch(
    html,
    /Comunidad Energética de Comunidad Energética Extremeña/,
  );
  assert.doesNotMatch(html, retiredExtremaduraOrganizations);
});

contractTest("leads the communities page with a direct saving benefit", async () => {
  const response = await renderPath("/comunidades-energeticas");
  const html = await response.text();
  const hero = html.match(
    /<section class="communities-hero">[\s\S]*?<\/section>/,
  )?.[0];

  assert.equal(response.status, 200);
  assert.ok(hero, "La página debe conservar un hero específico");
  assert.match(hero, /<span>Ahorra en tu factura<\/span>/);
  assert.match(hero, /<span>con energía solar<\/span>/);
  assert.match(hero, /generada <em>cerca de ti\.<\/em>/);
  assert.match(
    hero,
    /src="\/comunidades-colegio-pueblo-1024x792\.png"/,
  );
  assert.match(hero, /href="#cobertura"/);
  assert.match(hero, /href="#modelos"/);
  assert.doesNotMatch(hero, /La energía solar de tu zona/);
});

contractTest("separates total development activity from public community cards", async () => {
  const response = await renderPath("/comunidades-energeticas");
  const html = await response.text();
  const clarityIndex = html.indexOf(
    "Cada proyecto muestra su estado con total claridad",
  );
  const totalIndex = html.indexOf('class="community-scale-feature"');
  const networkIndex = html.indexOf('class="community-network-feature"');
  const publicIndex = html.indexOf('class="community-published-heading"');
  const cardsIndex = html.indexOf('class="community-card-grid"');

  assert.equal(response.status, 200);
  assert.match(html, /Cada proyecto muestra su estado con total claridad/);
  assert.match(
    html,
    /Consulta ubicación, modalidad, potencia, capacidad, hitos, fecha de actualización y siguiente acción\./,
  );
  assert.match(
    html,
    /Cuando un dato todavía no está validado, también lo decimos\./,
  );
  assert.doesNotMatch(html, /Una red que ya crece mucho más allá del mapa/);
  assert.match(html, /Lo que ves publicado es solo una parte/);
  assert.match(html, />\+320</);
  assert.match(html, />\+96 MW</);
  assert.match(html, /Proyectos en negociación o desarrollo activo/);
  assert.match(html, /No todos los proyectos están cerrados[\s\S]*ni disponibles/);
  assert.doesNotMatch(html, /proyectos en fases maduras/i);
  assert.ok(clarityIndex >= 0);
  assert.ok(totalIndex > clarityIndex);
  assert.ok(networkIndex > totalIndex);
  assert.ok(publicIndex > networkIndex);
  assert.ok(cardsIndex > publicIndex);
});

contractTest("publishes Ontinyent and Escurial as built communities on the waitlist", async () => {
  const index = await renderPath("/comunidades-energeticas");
  const sitemap = await renderPath("/sitemap.xml");
  const ontinyent = await renderPath(
    "/comunidades-energeticas/ontinyent",
  );
  const escurial = await renderPath("/comunidades-energeticas/escurial");
  const legacyOntinyent = await renderPath(
    "/comunidad-energetica-ontinyent",
  );
  const indexHtml = await index.text();
  const sitemapXml = await sitemap.text();
  const ontinyentHtml = await ontinyent.text();
  const escurialHtml = await escurial.text();

  assert.equal(index.status, 200);
  assert.equal(ontinyent.status, 200);
  assert.equal(escurial.status, 200);
  assert.match(indexHtml, /Ontinyent – Dream Home Textil/);
  assert.match(indexHtml, /Escurial – Mármoles Jiménez/);
  assert.match(
    indexHtml,
    /Instalación construida · lista de espera/,
  );
  assert.match(
    ontinyentHtml,
    /\/media\/comunidades\/ontinyent-dream-home-textil\.webp/,
  );
  assert.match(ontinyentHtml, /226/);
  assert.match(ontinyentHtml, /135,60 kWp/);
  assert.match(ontinyentHtml, /La instalación está construida/);
  assert.doesNotMatch(ontinyentHtml, /El proyecto está en preparación/);
  assert.match(
    escurialHtml,
    /\/media\/comunidades\/escurial-marmoles-jimenez\.webp/,
  );
  assert.match(escurialHtml, /174/);
  assert.match(escurialHtml, /109,62 kWp/);
  assert.match(escurialHtml, /Fotografía: Adolfobrigido/);
  assert.match(escurialHtml, /CC BY-SA 4\.0/);
  assert.doesNotMatch(escurialHtml, /El proyecto está en preparación/);
  assert.match(
    sitemapXml,
    /<loc>https:\/\/comunidadsolar\.es\/comunidades-energeticas\/ontinyent<\/loc>/,
  );
  assert.match(
    sitemapXml,
    /<loc>https:\/\/comunidadsolar\.es\/comunidades-energeticas\/escurial<\/loc>/,
  );
  assert.equal(legacyOntinyent.status, 308);
  assert.match(
    legacyOntinyent.headers.get("location") ?? "",
    /\/comunidades-energeticas\/ontinyent$/,
  );
});

contractTest("removes Robregordo from the community catalogue and sitemap", async () => {
  const index = await renderPath("/comunidades-energeticas");
  const sitemap = await renderPath("/sitemap.xml");
  const removedPage = await renderPath(
    "/comunidades-energeticas/robregordo",
  );
  const indexHtml = await index.text();
  const sitemapXml = await sitemap.text();

  assert.equal(index.status, 200);
  assert.equal(sitemap.status, 200);
  assert.equal(removedPage.status, 404);
  assert.doesNotMatch(indexHtml, /Robregordo/i);
  assert.doesNotMatch(sitemapXml, /\/comunidades-energeticas\/robregordo\b/i);
});

contractTest("links every Extremeña location page from its umbrella page and sitemap", async () => {
  const umbrella = await renderPath("/comunidades-energeticas/extremadura");
  const sitemap = await renderPath("/sitemap.xml");
  const umbrellaHtml = await umbrella.text();
  const sitemapXml = await sitemap.text();

  assert.equal(umbrella.status, 200);
  assert.equal(sitemap.status, 200);

  for (const slug of extremaduraLocationSlugs) {
    const path = `/comunidades-energeticas/${slug}`;
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(
      umbrellaHtml,
      new RegExp(`href="${escapedPath}"`),
      `La página paraguas debe enlazar la ficha de ${slug}`,
    );
    assert.match(
      sitemapXml,
      new RegExp(`<loc>https://comunidadsolar\\.es${escapedPath}</loc>`),
      `El sitemap debe publicar la ficha de ${slug}`,
    );

    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200, `${path} debe responder 200`);
    assert.doesNotMatch(html, retiredExtremaduraOrganizations);
  }
});

contractTest("uses the resident-focused template on every local community page", async () => {
  for (const slug of localCommunitySlugs) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200, `${slug} debe responder 200`);
    assert.match(
      html,
      /class="community-local-detail"/,
      `${slug} debe usar la ficha local`,
    );
    assert.match(html, /href="#instalaciones"/);
    assert.match(html, /href="#cobertura"/);
    assert.match(html, /Comprobar (?:mi )?cobertura/);
    assert.match(
      html,
      new RegExp(`data-community-origin="${slug}"`),
      `${slug} debe identificar el origen para Helios`,
    );
    assert.doesNotMatch(
      html,
      /último dato público consultado|La ficha separa hechos|Sin promesas vacías|La disponibilidad comercial no se confunde/i,
    );
  }
});

contractTest("uses customer-facing language on every community page", async () => {
  const forbiddenCopy = [
    /\bno publicad[oa]s?\b/i,
    /\binventario\b/i,
    /\bdatos consultados\b/i,
    /\bsin promesas vacías\b/i,
    /\b(?:paneles?|cubiertas?|precio|disponibilidad|referencia|potencia|participación)\s+publicad[oa]s?\b/i,
    /\bla ficha (?:comercial|separa|muestra|reúne|explica)\b/i,
  ];

  for (const slug of ["extremadura", ...localCommunitySlugs]) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200, `${slug} debe responder 200`);
    for (const pattern of forbiddenCopy) {
      assert.doesNotMatch(
        html,
        pattern,
        `${slug} no debe mostrar lenguaje de control interno`,
      );
    }
  }
});

contractTest("keeps the Extremeña umbrella and local hierarchy intact", async () => {
  const umbrella = await renderPath("/comunidades-energeticas/extremadura");
  const umbrellaHtml = await umbrella.text();

  assert.equal(umbrella.status, 200);
  assert.match(umbrellaHtml, /class="community-network-detail"/);
  assert.doesNotMatch(umbrellaHtml, /class="community-local-detail"/);

  for (const slug of extremaduraLocationSlugs) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      /href="\/comunidades-energeticas\/extremadura"/,
      `${slug} debe enlazar de vuelta a la red extremeña`,
    );
  }
});

contractTest("never turns unopened or unknown inventory into available panels", async () => {
  for (const slug of [
    "sepulveda",
    "santa-cruz-de-paniagua",
    ...extremaduraLocationSlugs,
  ]) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Paneles previstos/);
    assert.doesNotMatch(html, /Paneles disponibles/);
    assert.doesNotMatch(html, /La energía llega a tu factura/);
  }

  const expectedOpenAvailability = new Map([
    ["villaverde-getafe", "66"],
    ["nuevo-baztan", "306"],
    ["ceuti", "117"],
    ["villalbilla", "77"],
    ["ibeas-de-juarros", "88"],
    ["san-adrian-de-juarros", "0"],
  ]);

  for (const [slug, expected] of expectedOpenAvailability) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      new RegExp(`>${expected}<\\/strong><span>Paneles disponibles`),
      `${slug} debe mostrar su disponibilidad real`,
    );
  }
});

contractTest("publishes the verified community inventory without mixing totals", async () => {
  const extremadura = await renderPath(
    "/comunidades-energeticas/extremadura",
  );
  const extremaduraHtml = await extremadura.text();

  assert.equal(extremadura.status, 200);
  assert.match(
    extremaduraHtml,
    />10<\/strong><span>Comunidades locales</,
  );
  assert.match(
    extremaduraHtml,
    />15<\/strong><span>Instalaciones previstas</,
  );
  assert.match(
    extremaduraHtml,
    />2\.915<\/strong><span>Paneles previstos</,
  );
  assert.match(
    extremaduraHtml,
    />1\.831 kWp<\/strong><span>Potencia conjunta</,
  );

  const merida = await renderPath("/comunidades-energeticas/merida");
  const meridaHtml = await merida.text();

  assert.equal(merida.status, 200);
  assert.match(
    meridaHtml,
    /4 instalaciones previstas para esta comunidad/,
  );
  assert.match(meridaHtml, />825<\/strong><span>Paneles previstos</);
  assert.match(
    meridaHtml,
    />495 kWp<\/strong><span>Potencia total del proyecto</,
  );
  assert.match(
    meridaHtml,
    /calculadoraenergetica\.comunidadsolar\.es/,
  );
  assert.match(
    meridaHtml,
    /\/media\/comunidades\/extremadura\/merida\.webp/,
  );
  assert.match(
    meridaHtml,
    /Simulación de paneles solares sobre una de las cubiertas de la Comunidad Energética de Mérida/,
  );
  assert.doesNotMatch(
    meridaHtml,
    /M%C3%A9rida%201|Imagen ilustrativa de una cubierta solar que comparte energía con su entorno/,
  );
  assert.doesNotMatch(
    meridaHtml,
    /<dt>Paneles incorporados<\/dt>|<dt>Participantes registrados<\/dt>/,
  );

  const villalbilla = await renderPath(
    "/comunidades-energeticas/villalbilla",
  );
  const villalbillaHtml = await villalbilla.text();

  assert.equal(villalbilla.status, 200);
  assert.match(villalbillaHtml, /Colegio Gregorio Canella/);
  assert.match(villalbillaHtml, /CEIP Salvador Dalí/);
  assert.match(
    villalbillaHtml,
    /<dt>Paneles<\/dt><dd>215<\/dd>/,
  );
  assert.match(
    villalbillaHtml,
    /<dt>Paneles<\/dt><dd>207<\/dd>/,
  );
  assert.match(
    villalbillaHtml,
    />255,31 kWp<\/strong><span>Potencia total del proyecto</,
  );

  const ibeas = await renderPath(
    "/comunidades-energeticas/ibeas-de-juarros",
  );
  const ibeasHtml = await ibeas.text();

  assert.equal(ibeas.status, 200);
  assert.match(ibeasHtml, /<dt>Paneles<\/dt><dd>142<\/dd>/);
  assert.match(
    ibeasHtml,
    />93,72 kWp<\/strong><span>Potencia total del proyecto</,
  );
  assert.doesNotMatch(ibeasHtml, /106 kWp|0,70922/);
});

contractTest("does not confuse commercial completion with technical completion", async () => {
  const nuevoBaztan = await renderPath(
    "/comunidades-energeticas/nuevo-baztan",
  );
  const nuevoBaztanHtml = await nuevoBaztan.text();

  assert.equal(nuevoBaztan.status, 200);
  assert.match(nuevoBaztanHtml, /Tres cubiertas municipales/);
  assert.match(nuevoBaztanHtml, /Última plaza disponible/);
  assert.doesNotMatch(
    nuevoBaztanHtml,
    /Nave Municipal[\s\S]{0,1400}Participación completa/,
  );

  const sanAdrian = await renderPath(
    "/comunidades-energeticas/san-adrian-de-juarros",
  );
  const sanAdrianHtml = await sanAdrian.text();

  assert.equal(sanAdrian.status, 200);
  assert.match(sanAdrianHtml, /Participación completa/);
  assert.match(sanAdrianHtml, /La comunidad no tiene plazas disponibles/);
  assert.match(sanAdrianHtml, /Comprobar alternativas/);
  assert.match(
    sanAdrianHtml,
    />0<\/strong><span>Paneles disponibles</,
  );
  assert.doesNotMatch(sanAdrianHtml, /Proyecto completo/);
});

contractTest("hides unconfirmed technical and billing states", async () => {
  for (const slug of [
    "san-adrian-de-juarros",
    "sepulveda",
    "santa-cruz-de-paniagua",
    ...extremaduraLocationSlugs,
  ]) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200, `${slug} debe responder 200`);
    assert.doesNotMatch(
      html,
      /class="community-local-installation-state"/,
      `${slug} no debe rellenar estados que no están confirmados`,
    );
    assert.match(html, /Confirmar calendario y condiciones/);
  }
});

contractTest("publishes every community slug only once", async () => {
  const sitemap = await renderPath("/sitemap.xml");
  const sitemapXml = await sitemap.text();
  const communityPaths = [
    ...sitemapXml.matchAll(
      /<loc>https:\/\/comunidadsolar\.es(\/comunidades-energeticas\/[^<]+)<\/loc>/g,
    ),
  ].map((match) => match[1]);

  assert.equal(sitemap.status, 200);
  assert.ok(communityPaths.length > 0);
  assert.equal(
    new Set(communityPaths).size,
    communityPaths.length,
    "No puede haber dos fichas publicadas con el mismo slug",
  );
});

contractTest("every community page uses local image files that exist", async () => {
  const sitemap = await renderPath("/sitemap.xml");
  const sitemapXml = await sitemap.text();
  const communityPaths = [
    ...sitemapXml.matchAll(
      /<loc>https:\/\/comunidadsolar\.es(\/comunidades-energeticas\/[^<]+)<\/loc>/g,
    ),
  ].map((match) => match[1]);
  const checkedImages = new Set();

  assert.equal(sitemap.status, 200);

  for (const path of communityPaths) {
    const response = await renderPath(path);
    const html = await response.text();
    const imagePaths = [
      ...html.matchAll(/(?:src|content)="(\/media\/[^"?#]+)(?:[?#][^"]*)?"/g),
    ].map((match) => decodeURIComponent(match[1]));

    assert.equal(response.status, 200, `${path} debe responder 200`);
    assert.doesNotMatch(html, /comunidadsolar\.es\/wp-content\/uploads\//);
    assert.ok(
      imagePaths.length > 0,
      `${path} debe referenciar al menos una imagen local`,
    );

    for (const imagePath of imagePaths) {
      if (checkedImages.has(imagePath)) continue;
      checkedImages.add(imagePath);

      const image = await readProjectAsset(imagePath);
      assert.ok(
        image.byteLength > 0,
        `${imagePath} debe existir y no estar vacío`,
      );
    }
  }
});

contractTest("uses one distinct local image for every Extremeña community", async () => {
  const imageOwners = new Map();

  for (const slug of extremaduraLocationSlugs) {
    const response = await renderPath(`/comunidades-energeticas/${slug}`);
    const html = await response.text();
    const imageMatch = html.match(
      /<div class="page-hero-visual"><img src="(\/media\/comunidades\/extremadura\/[^"]+)" alt="([^"]+)"/,
    );

    assert.equal(response.status, 200, `${slug} debe responder 200`);
    assert.ok(imageMatch, `${slug} debe utilizar una imagen local extremeña`);

    const [, imagePath, imageAlt] = imageMatch;
    const image = await readProjectAsset(imagePath);
    const digest = createHash("sha256").update(image).digest("hex");
    const previousOwner = imageOwners.get(digest);

    assert.equal(
      previousOwner,
      undefined,
      `${slug} no puede repetir la imagen utilizada por ${previousOwner}`,
    );
    assert.ok(
      imageAlt.trim().length > 20,
      `${slug} debe describir su cubierta o localidad`,
    );
    assert.doesNotMatch(
      imageAlt,
      /Imagen ilustrativa de una cubierta solar que comparte energía con su entorno/,
    );

    imageOwners.set(digest, slug);
  }

  assert.equal(imageOwners.size, extremaduraLocationSlugs.length);
});

contractTest("separates Torrontera production from its incorporation into Comunidad Solar", async () => {
  const project = await renderPath("/autoconsumo-remoto/torrontera");
  const projectHtml = await project.text();

  assert.equal(project.status, 200);
  assert.match(projectHtml, /2,06 MWp/);
  assert.doesNotMatch(projectHtml, /3\.788 MWh/);
  assert.match(projectHtml, /4 MWh/);
  assert.match(projectHtml, /3\.808/);
  assert.match(projectHtml, /paneles de 540 W/);
  assert.match(projectHtml, /seguimiento solar/i);
  assert.match(projectHtml, /Calcular mi propuesta/);
  assert.match(projectHtml, /Torrontera I produce desde agosto de 2023/);
  assert.match(projectHtml, /Torrontera II desde\s+marzo de 2024/);
  assert.match(projectHtml, /se incorporaron a Comunidad Solar\s+en 2025/);
  assert.match(projectHtml, /40 años/);
  assert.match(projectHtml, /0,00 €\/kWh/);
  assert.match(projectHtml, /compras por adelantado/i);
  assert.match(projectHtml, /una instalación concreta/i);
  assert.match(projectHtml, /Excedentes vendidos hora a hora/);
  assert.match(projectHtml, /El suministro no tiene permanencia/);
  assert.match(projectHtml, /1 € \+ IVA por panel y mes/);
  assert.match(projectHtml, /3 € \+ IVA al\s+mes de cuota Comunidad Solar/);
  assert.match(projectHtml, /No compras una promesa de rentabilidad rápida/);
  assert.match(projectHtml, /potencia contratada, peajes, cargos e impuestos/);
  assert.match(projectHtml, /energía de red que Torrontera no cubra/);
  assert.match(projectHtml, /no funciona como respaldo\s+de tu vivienda ante un apagón/);
  assert.doesNotMatch(projectHtml, /Mazarrón/);
  assert.doesNotMatch(projectHtml, /asociar(?:la)? a otro suministro/i);
  assert.doesNotMatch(projectHtml, /Datos públicos, contrato privado/);
  assert.doesNotMatch(projectHtml, /Consultar la fuente original/);
  assert.doesNotMatch(projectHtml, /ahorro garantizado/i);
  assert.doesNotMatch(projectHtml, /amortiza.*pocos años/i);
  assert.doesNotMatch(projectHtml, /ficha (pública|comercial|técnica)/i);

  const article = await renderPath("/blog/torrontera-ya-esta-en-marcha");
  const articleHtml = await article.text();

  assert.equal(article.status, 200);
  assert.match(articleHtml, /Torrontera se incorpora a Comunidad Solar/);
  assert.match(
    articleHtml,
    /documenta la incorporación de Torrontera a Comunidad Solar, no el inicio de su producción/,
  );
  assert.doesNotMatch(
    articleHtml,
    /Un nuevo parque empieza a producir|Torrontera pasó de proyecto a realidad/,
  );
});

contractTest("rebuilds Fuente Álamo and Pisuerga from their useful legacy information", async () => {
  const fuenteAlamo = await renderPath("/autoconsumo-remoto/fuente-alamo");
  const fuenteAlamoHtml = await fuenteAlamo.text();

  assert.equal(fuenteAlamo.status, 200);
  assert.match(fuenteAlamoHtml, /La Cervantina/);
  assert.doesNotMatch(fuenteAlamoHtml, /Lazarillo/);
  assert.match(fuenteAlamoHtml, /1\.903/);
  assert.match(fuenteAlamoHtml, /1,03 MWp/);
  assert.doesNotMatch(fuenteAlamoHtml, /1,2 MW/);
  assert.match(fuenteAlamoHtml, /Seguimiento solar/);
  assert.match(fuenteAlamoHtml, /Sin plazas disponibles/);
  assert.doesNotMatch(fuenteAlamoHtml, /Consultar la fuente original/);

  const pisuerga = await renderPath("/autoconsumo-remoto/liguerzana");
  const pisuergaHtml = await pisuerga.text();

  assert.equal(pisuerga.status, 200);
  assert.match(pisuergaHtml, /Central del Pisuerga/);
  assert.match(pisuergaHtml, /500 kW/);
  assert.match(pisuergaHtml, /3\.262 × 75 W/);
  assert.match(pisuergaHtml, /2\.554 × 100 W/);
  assert.match(pisuergaHtml, /El agua aporta la fuerza/);
  assert.match(pisuergaHtml, /El generador produce/);
  assert.match(pisuergaHtml, /fuera de las horas de sol/);
  assert.match(pisuergaHtml, /caudal, las estaciones, las condiciones ambientales/);
  assert.match(pisuergaHtml, /No significa que existan 5\.816 turbinas físicas/);
  assert.match(pisuergaHtml, /Ver proyectos disponibles/);
  assert.match(pisuergaHtml, /Entrar en mi app/);
  assert.doesNotMatch(pisuergaHtml, /producción diurna y nocturna asegurada/i);
  assert.doesNotMatch(pisuergaHtml, /Consultar la fuente original/);
  assert.doesNotMatch(pisuergaHtml, /La antigua ficha Megapark/i);
});

contractTest("keeps one complete and valid legacy redirect map", async () => {
  const source = await readMigratedSource("legacy-routes");
  const redirects = [
    ...source.matchAll(
      /\{\s*from:\s*"([^"]+)",\s*to:\s*"([^"]+)",\s*group:\s*"[^"]+",?\s*\}/g,
    ),
  ].map((match) => ({ from: match[1], to: match[2] }));
  const uniqueSources = new Set(redirects.map(({ from }) => from));
  const readArrayBlock = (name) => {
    const match = source.match(
      new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`),
    );

    assert.ok(match, `Debe existir el inventario ${name}`);
    return match[1];
  };
  const inventory = [
    ...readArrayBlock("legacyWordPressSitemapPaths").matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  const gonePaths = new Set(
    [...readArrayBlock("legacyGonePaths").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  const pendingPaths = new Set(
    [
      ...readArrayBlock("legacyRoutesPendingDecision").matchAll(
        /path:\s*"([^"]+)"/g,
      ),
    ].map((match) => match[1]),
  );
  const preservedPaths = new Set(
    [...readArrayBlock("legacyPreservedPaths").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );

  assert.ok(redirects.length >= 50);
  assert.equal(uniqueSources.size, redirects.length);
  assert.equal(inventory.length, 122);
  assert.equal(new Set(inventory).size, inventory.length);

  for (const path of inventory) {
    const classifications = [
      uniqueSources.has(path),
      gonePaths.has(path),
      pendingPaths.has(path),
      preservedPaths.has(path),
    ].filter(Boolean);

    assert.equal(
      classifications.length,
      1,
      `${path} debe tener una única decisión de migración`,
    );
  }

  for (const requiredPath of [
    "/proyecto-torrontera",
    "/megapark-fuente-alamo",
    "/megapark-pisuerga",
    "/megapark-las-vegas",
    "/comunidad-energetica-nuevo-baztan-v2",
    "/ce-villalbilla-test",
  ]) {
    assert.ok(
      uniqueSources.has(requiredPath),
      `${requiredPath} debe estar en el mapa de redirecciones`,
    );
  }

  for (const { from, to } of redirects) {
    const response = await renderPath(`${from}/`);
    const location = response.headers.get("location");

    assert.equal(response.status, 308, `${from} debe redirigir permanentemente`);
    assert.ok(location, `${from} debe incluir un destino`);

    const actualDestination = new URL(location, "http://localhost");
    const expectedDestination = new URL(to, "http://localhost");

    assert.equal(actualDestination.pathname, expectedDestination.pathname);
    assert.equal(actualDestination.hash, expectedDestination.hash);
    assert.notEqual(actualDestination.pathname, from);

    const destinationResponse = await renderPath(actualDestination.pathname);
    const destinationHtml = await destinationResponse.text();

    assert.equal(
      destinationResponse.status,
      200,
      `El destino ${actualDestination.pathname} de ${from} debe existir`,
    );

    if (actualDestination.hash) {
      const id = actualDestination.hash.slice(1);
      const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(
        destinationHtml,
        new RegExp(`\\bid="${escapedId}"`),
        `El destino ${to} debe contener su ancla`,
      );
    }
  }

  const trackedRedirect = await renderPath(
    "/proyecto-torrontera/?utm_source=wordpress",
  );
  assert.match(
    trackedRedirect.headers.get("location") ?? "",
    /\/autoconsumo-remoto\/torrontera\?utm_source=wordpress$/,
  );
});

contractTest("retires invalid historical projects and inventories CRM decisions", async () => {
  const source = await readMigratedSource("legacy-routes");

  for (const path of [
    "/comunidad-energetica-robregordo/",
    "/megapark-serracin/",
    "/invierte-en-comunidad-solar/",
    "/blog/elementor-hf/menu-principal/",
  ]) {
    const response = await renderPath(path);

    assert.equal(response.status, 410, `${path} debe quedar retirada`);
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  }

  assert.doesNotMatch(source, /path: "\/comunidad-energetica-ontinyent"/);
  assert.match(source, /path: "\/ce-villanueva-de-guadamejud-v2"/);
});

contractTest("links the home page to the native commercializer route", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /href="\/comercializadora-y-tarifas"/);
  assert.doesNotMatch(html, /https:\/\/comunidadsolar\.es\/tarifas\//);
});

contractTest("redirects the legacy tariffs route", async () => {
  const response = await renderPath("/tarifas");

  assert.equal(response.status, 308);
  assert.match(
    response.headers.get("location") ?? "",
    /\/comercializadora-y-tarifas$/,
  );
});

contractTest("renders the native maintenance page with clear responsibilities", async () => {
  const response = await renderPath("/mantenimiento");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Mantenimiento recomendado por Comunidad Solar/);
  assert.match(html, /Solaico confirma el alcance, formaliza contigo el contrato/);
  assert.match(html, /La garantía responde\. El mantenimiento se anticipa/);
  assert.match(html, /Seguimiento mediante la app/);
  assert.match(html, /UNIÓN COMPOSITES, S\.L\./);
  assert.doesNotMatch(html, /Urgencias eléctricas 24h/);
  assert.doesNotMatch(html, /219\s*€/);
});

contractTest("renders the native solar installation page as a tailored study", async () => {
  const response = await renderPath("/autoconsumo-en-mi-tejado");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /Tu instalación empieza por entender cómo utilizas la energía/,
  );
  assert.match(html, /No se trata de llenar el tejado/);
  assert.match(
    html,
    /La batería no siempre se instala\. Pero siempre se valora desde el principio/,
  );
  assert.match(html, /Solicitar mi estudio solar/);
  assert.match(html, /href="\/baterias#solax-x1-ies"/);
  assert.match(html, /Batería valorada en el diseño/);
  assert.match(html, /instaladores especializados seleccionados/);
  assert.doesNotMatch(
    html,
    /se paga sola|cash flow neutro|hasta un 60%|los mejores instaladores/i,
  );
});

contractTest("renders one native battery page with qualified backup claims", async () => {
  const response = await renderPath("/baterias");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /Una batería para tu hogar, tengas o no placas solares/,
  );
  assert.match(html, /SolaX X1-IES de 5 kW con 5,1 kWh/);
  assert.match(html, /4\.799\s*€/);
  assert.match(html, /Sin paneles solares/);
  assert.match(
    html,
    /Instalación, puesta en marcha y legalización/,
  );
  assert.match(html, /TIN, TAE/);
  assert.match(
    html,
    /Una batería no convierte automáticamente tu casa en una isla/,
  );
  assert.match(
    html,
    /https:\/\/calculadorabaterias\.comunidadsolar\.es\//,
  );
  assert.match(html, /data-analytics-event="battery_calculator_open"/);
  assert.doesNotMatch(
    html,
    /Huawei|EcoFlow|guerra|España al borde|siempre con energía/i,
  );
});

contractTest("renders one native aerothermal page based on the home study", async () => {
  const response = await renderPath("/aerotermia");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /Calefacción, refrigeración y agua caliente desde un único sistema/,
  );
  assert.match(html, /La aerotermia no empieza por elegir una máquina/);
  assert.match(html, /Suelo radiante/);
  assert.match(html, /Fancoils/);
  assert.match(html, /Radiadores/);
  assert.match(html, /Coolfy es nuestro instalador Premium y partner oficial/);
  assert.match(html, /El equipo que se ocupa de todo el proceso contratado/);
  assert.match(html, /Solicitar estudio con Coolfy/);
  assert.match(html, /https:\/\/www\.coolfy\.net\/quiero-aerotermia-ya/);
  assert.match(html, /data-analytics-event="coolfy_aerothermal_open"/);
  assert.doesNotMatch(html, /https:\/\/comunidadsolar\.zohobookings\.eu/);
  assert.doesNotMatch(
    html,
    /Acierta Eficiencia|15\.000\s*€|hasta 9\.000\s*€|50 al 70%/i,
  );
});

contractTest("links the home and navigation to all native home-energy products", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  for (const path of [
    "/autoconsumo-en-mi-tejado",
    "/baterias",
    "/aerotermia",
  ]) {
    assert.match(html, new RegExp(`href="${path}"`));
  }
  assert.match(html, /Con Coolfy, nuestro partner oficial/);
  assert.doesNotMatch(
    html,
    /https:\/\/comunidadsolar\.es\/(?:autoconsumo-en-mi-tejado|oferta-baterias-huawei|aerotermia-comunidad-solarcoolfy)/,
  );
});

contractTest("retires the electric-car charger product completely", async () => {
  const retiredPage = await renderPath("/cargador-de-coche-electrico");
  const home = await renderPath("/");
  const solar = await renderPath("/autoconsumo-en-mi-tejado");
  const sitemap = await renderPath("/sitemap.xml");
  const homeHtml = await home.text();
  const solarHtml = await solar.text();
  const sitemapXml = await sitemap.text();

  assert.equal(retiredPage.status, 410);
  assert.equal(retiredPage.headers.get("x-robots-tag"), "noindex");
  assert.equal(home.status, 200);
  assert.equal(solar.status, 200);
  assert.equal(sitemap.status, 200);

  for (const html of [homeHtml, solarHtml]) {
    assert.doesNotMatch(html, /cargador-de-coche-electrico/i);
    assert.doesNotMatch(html, /Cargador eléctrico|Ver cargadores/i);
  }

  assert.doesNotMatch(sitemapXml, /cargador-de-coche-electrico/i);
});

contractTest("redirects superseded home-energy campaigns to their native pages", async () => {
  const redirects = new Map([
    ["/autoconsumo-en-mi-tejado-v2", "/autoconsumo-en-mi-tejado"],
    ["/oferta-baterias-huawei", "/baterias"],
    ["/oferta-baterias-solax-x1-ies", "/baterias"],
    [
      "/oferta-baterias-ecoflow-powerocean-con-instalacion-fotovoltaica",
      "/baterias",
    ],
    ["/compra-grupo-aerotermia", "/aerotermia"],
    ["/aerotermia-comunidad-solarcoolfy", "/aerotermia"],
  ]);

  for (const [from, to] of redirects) {
    const response = await renderPath(from);

    assert.equal(response.status, 308);
    assert.equal(
      new URL(response.headers.get("location"), "http://localhost").pathname,
      to,
    );
  }
});

contractTest("redirects the former SolaX campaign to the current offer section", async () => {
  const response = await renderPath("/oferta-baterias-solax-x1-ies");
  const location = new URL(
    response.headers.get("location"),
    "http://localhost",
  );

  assert.equal(response.status, 308);
  assert.equal(location.pathname, "/baterias");
  assert.equal(location.hash, "#solax-x1-ies");
});

contractTest("publishes the three native home-energy pages in the sitemap", async () => {
  const response = await renderPath("/sitemap.xml");
  const xml = await response.text();

  assert.equal(response.status, 200);
  for (const path of [
    "/autoconsumo-en-mi-tejado",
    "/baterias",
    "/aerotermia",
  ]) {
    assert.match(
      xml,
      new RegExp(
        `<loc>https://comunidadsolar\\.es${path.replaceAll("/", "\\/")}<\\/loc>`,
      ),
    );
  }
});

contractTest("links the home page to the native maintenance route", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /href="\/mantenimiento"/);
  assert.doesNotMatch(
    html,
    /https:\/\/comunidadsolar\.es\/mantenimiento-placas-solares\//,
  );
});

contractTest("orders coverage, strategic turn, three worlds and media on the home page", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);

  const coverageIndex = html.indexOf('id="cobertura"');
  const marketIndex = html.indexOf("El mercado ha cambiado. Nosotros también.");
  const worldsIndex = html.indexOf("Tres caminos. Una misma misión.");
  const mediaIndex = html.indexOf('id="medios"');

  assert.ok(coverageIndex >= 0);
  assert.ok(marketIndex > coverageIndex);
  assert.ok(worldsIndex > marketIndex);
  assert.ok(mediaIndex > worldsIndex);

  for (const world of [
    "Comunidad energética",
    "Autoconsumo remoto",
    "Instalación en tu tejado",
  ]) {
    assert.match(html, new RegExp(`>${world}<`));
  }

  for (const outlet of [
    "Antena 3",
    "Cadena SER",
    "Xataka",
    "El Español",
    "Energías Renovables",
    "La Razón",
  ]) {
    assert.match(html, new RegExp(`>${outlet}<`));
  }

  assert.match(html, /href="https:\/\/www\.antena3\.com\/noticias\/economia\//);
  assert.match(html, /href="https:\/\/cadenaser\.com\/cmadrid\/2023\/04\/20\//);
  assert.match(
    html,
    /src="\/media\/antena3-noticias-autoconsumo-remoto-2023\.jpg"/,
  );
  assert.match(
    html,
    /alt="Antena 3 Noticias presenta un reportaje sobre energía solar"/,
  );
  assert.match(html, /class="press-trust-lead"/);
  assert.match(html, /class="press-trust-secondary"/);
  assert.match(html, /class="press-trust-index"/);
});

contractTest("does not promote subsidies as a service", async () => {
  for (const path of ["/", "/nosotros", "/contacto"]) {
    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /Subvenciones/i);
    assert.doesNotMatch(html, /gestionamos-subvenciones/i);
  }
});

contractTest("protects the synced team guide and keeps its source server-only", async () => {
  const anonymousGuide = await renderPath("/guia-equipo");
  const anonymousHtml = await anonymousGuide.text();

  assert.equal(anonymousGuide.status, 200);
  assert.match(anonymousHtml, /Manual del equipo/);
  assert.match(anonymousHtml, /Identificarme con ChatGPT/);
  assert.doesNotMatch(
    anonymousHtml,
    /Manual estratégico y de implementación de la web de Comunidad Solar/,
  );

  const guide = await renderPath("/guia-equipo", {
    headers: {
      "oai-authenticated-user-email": "paco@comunidad.solar",
      "oai-authenticated-user-full-name": "Paco%20Ragageles",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
    env: {
      TEAM_ALLOWED_EMAILS: "paco@comunidad.solar",
    },
  });
  const guideHtml = await guide.text();

  assert.equal(guide.status, 200);
  assert.match(
    guideHtml,
    /Manual estratégico y de implementación de la web de Comunidad Solar/,
  );
  assert.match(guideHtml, /64 rutas de contenido documentadas/);
  assert.match(
    guideHtml,
    /href="\/guia-equipo-nueva-web-comunidad-solar\.md"/,
  );
  assert.match(
    guideHtml,
    /name="robots" content="noindex, nofollow, noarchive, noimageindex"/,
  );
  assert.match(guide.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(guide.headers.get("cache-control") ?? "", /public/);

  for (const path of ["/", "/comunidades-energeticas", "/autoconsumo-remoto"]) {
    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /PROPUESTA WEB|Prototipo visual|ESPACIO PREPARADO|ANTES DE PUBLICAR/i);
    assert.doesNotMatch(html, /href="\/guia-equipo"/);
  }
});

contractTest("serves the downloadable Markdown only to an authorised team account", async () => {
  const anonymousResponse = await renderPath(
    "/guia-equipo-nueva-web-comunidad-solar.md",
  );
  assert.equal(anonymousResponse.status, 307);
  assert.match(
    anonymousResponse.headers.get("location") ?? "",
    /\/signin-with-chatgpt\?return_to=/,
  );

  const response = await renderPath(
    "/guia-equipo-nueva-web-comunidad-solar.md",
    {
      headers: {
        "oai-authenticated-user-email": "paco@comunidad.solar",
      },
      env: {
        TEAM_ALLOWED_EMAILS: "paco@comunidad.solar",
      },
    },
  );
  const markdown = await response.text();
  const source = await readMigratedSource("guide");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /guia-equipo-nueva-web-comunidad-solar\.md/,
  );
  assert.match(
    response.headers.get("x-robots-tag") ?? "",
    /noindex, nofollow, noarchive/,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(
    markdown,
    /Manual estratégico y de implementación de la web de Comunidad Solar/,
  );
  assert.match(markdown, /\*\*64 rutas de contenido\*\*/);
  assert.match(
    markdown,
    /https:\/\/calculadoraenergetica\.comunidadsolar\.es/,
  );
  assert.match(
    markdown,
    /El formulario de plantas operativas es deliberadamente exhaustivo/,
  );
  assert.doesNotMatch(markdown, /\{\{TOTAL_CONTENT_ROUTES\}\}/);
  assert.match(source, /\{\{TOTAL_CONTENT_ROUTES\}\}/);
});

contractTest("keeps the partner information room private and fails closed", async () => {
  const anonymous = await renderPath("/socios");
  const anonymousHtml = await anonymous.text();

  assert.equal(anonymous.status, 200);
  assert.match(anonymousHtml, /Área de socios fundadores/);
  assert.match(anonymousHtml, /Identificarme con ChatGPT/);
  assert.match(
    anonymousHtml,
    /\/signin-with-chatgpt\?return_to=%2Fsocios/,
  );
  assert.doesNotMatch(anonymousHtml, /Puebla del Príncipe/);
  assert.doesNotMatch(anonymousHtml, /524\.944/);
  assert.doesNotMatch(anonymousHtml, /6\.265\.520/);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(anonymous.headers.get("cache-control") ?? "", /public/);
  assert.match(
    anonymous.headers.get("x-robots-tag") ?? "",
    /noindex, nofollow, noarchive/,
  );

  const denied = await renderPath("/socios", {
    headers: {
      "oai-authenticated-user-email": "otra-persona@example.com",
    },
    env: {
      SOCIOS_ALLOWED_EMAILS: "paco@comunidad.solar",
    },
  });
  const deniedHtml = await denied.text();

  assert.equal(denied.status, 200);
  assert.match(deniedHtml, /Esta cuenta no figura entre las autorizadas/);
  assert.match(deniedHtml, /otra-persona@example\.com/);
  assert.doesNotMatch(deniedHtml, /Puebla del Príncipe/);

  const authorised = await renderPath("/socios", {
    headers: {
      "oai-authenticated-user-email": "PACO@COMUNIDAD.SOLAR",
      "oai-authenticated-user-full-name": "Paco%20Ragageles",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
    env: {
      SOCIOS_ALLOWED_EMAILS:
        "socia@example.com; paco@comunidad.solar\notro@example.com",
    },
  });
  const authorisedHtml = await authorised.text();

  assert.equal(authorised.status, 200);
  assert.match(authorisedHtml, /Una nueva etapa para/);
  assert.match(authorisedHtml, /Comunidad Solar/);
  assert.match(authorisedHtml, /Paco Ragageles/);
  assert.match(authorisedHtml, /Puebla del Príncipe/);
  assert.match(authorisedHtml, /6\.265\.520/);
  assert.match(authorisedHtml, /Notaría para la compra del proyecto Chiva/);
  assert.match(authorisedHtml, /Pablo Bordas/);
  assert.match(authorisedHtml, /Carlos Aguilera/);
  assert.match(authorisedHtml, /30 de julio de 2026/);
  assert.match(authorisedHtml, /Confidencial · socios fundadores/);
  assert.match(
    authorisedHtml,
    /name="robots" content="noindex, nofollow, noarchive, noimageindex"/,
  );
});

contractTest("links the public site discreetly to the partner access without tracking private pages", async () => {
  const home = await renderPath("/");
  const html = await home.text();
  const consentSource = await readMigratedSource("consent");
  const robotsSource = await readMigratedSource("robots");

  assert.equal(home.status, 200);
  assert.equal(
    (html.match(/href="\/socios"/g) ?? []).length,
    0,
    "El acceso de socios no debe enlazarse desde ninguna página pública",
  );
  assert.match(consentSource, /pathname === "\/socios"/);
  assert.match(consentSource, /pathname\.startsWith\("\/socios\/"\)/);
  assert.match(robotsSource, /"\/socios"/);
  assert.match(robotsSource, /"\/guia-equipo"/);
});

contractTest("launches the Helios coverage calculator with a coherent journey", async () => {
  for (const path of [
    "/",
    "/comunidades-energeticas",
    "/comunidades-energeticas/villalbilla",
  ]) {
    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(
      html,
      /https:\/\/calculadoraenergetica\.comunidadsolar\.es/,
    );
    assert.match(html, /Comprobar mi cobertura/);
    assert.match(html, /Tu dirección/);
    assert.match(html, /Tu factura/);
    assert.match(html, /Tu propuesta/);
    assert.match(html, /data-analytics-event="coverage_calculator_open"/);
    assert.doesNotMatch(html, /ComunidadesEnergeticasVecinos/);
    assert.doesNotMatch(html, /WEBFormulariocomunidadenergetica/);
    assert.doesNotMatch(html, /El equipo comprueba la comunidad más cercana/);
    assert.doesNotMatch(html, /Completar comprobación/);
  }

  const waitlist = await renderPath(
    "/comunidades-energeticas/don-benito",
  );
  const waitlistHtml = await waitlist.text();

  assert.equal(waitlist.status, 200);
  assert.match(waitlistHtml, /Comprobar cobertura y apuntarme/);
  assert.match(waitlistHtml, /Tus datos/);
  assert.match(waitlistHtml, /Lista de espera/);
  assert.match(waitlistHtml, /Cuando confirmemos las condiciones/);
  assert.doesNotMatch(waitlistHtml, /deja preparada tu propuesta/);

  const consentSource = await readMigratedSource("consent");
  assert.match(consentSource, /dataset\.analyticsEvent/);
  assert.doesNotMatch(consentSource, /coverage_form_open/);
});

contractTest("serves local images instead of WordPress media dependencies", async () => {
  for (const path of ["/", "/blog", "/eventos", "/comunidades-energeticas", "/autoconsumo-remoto"]) {
    const response = await renderPath(path);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /comunidadsolar\.es\/wp-content\/uploads/);
  }
});

contractTest("publishes robots and sitemap endpoints", async () => {
  const robots = await renderPath("/robots.txt");
  const sitemap = await renderPath("/sitemap.xml");

  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \//);
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /https:\/\/comunidadsolar\.es\/comunidades-energeticas/);
});

contractTest("keeps every published route and internal link valid", async () => {
  const sitemapResponse = await renderPath("/sitemap.xml");
  const sitemapXml = await sitemapResponse.text();
  const publishedUrls = [
    ...sitemapXml.matchAll(/<loc>(https:\/\/comunidadsolar\.es[^<]*)<\/loc>/g),
  ].map((match) => match[1]);
  const rendered = new Map();

  async function getRendered(path) {
    if (!rendered.has(path)) {
      const response = await renderPath(path);
      rendered.set(path, {
        status: response.status,
        html: await response.text(),
      });
    }
    return rendered.get(path);
  }

  for (const pageUrl of publishedUrls) {
    const page = new URL(pageUrl);
    const current = await getRendered(`${page.pathname}${page.search}`);

    assert.equal(
      current.status,
      200,
      `La ruta publicada ${page.pathname} debe responder 200`,
    );

    const hrefs = [
      ...current.html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g),
    ].map((match) => match[1].replaceAll("&amp;", "&"));

    for (const href of hrefs) {
      if (!href.startsWith("/") && !href.startsWith("#")) continue;
      const target = new URL(href, page);

      const targetPath = `${target.pathname}${target.search}`;
      const destination = await getRendered(targetPath);

      assert.equal(
        destination.status,
        200,
        `${page.pathname} enlaza a ${targetPath}, que no responde 200`,
      );

      if (target.hash) {
        const id = decodeURIComponent(target.hash.slice(1));
        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(
          destination.html,
          new RegExp(`\\bid="${escapedId}"`),
          `${page.pathname} enlaza a la ancla inexistente ${target.hash} de ${target.pathname}`,
        );
      }
    }
  }
});

contractTest("publishes the four legal documents natively without changing their text", async () => {
  const source = await readMigratedSource("legal-content");
  const serialized = source.match(
    /export const legalDocuments = ([\s\S]*?) as const;/,
  )?.[1];

  assert.ok(serialized, "Debe existir la fuente legal literal");
  const documents = JSON.parse(serialized);
  const expected = {
    privacy: {
      path: "/politica-privacidad",
      hash: "b4f50522ff43f0fc8107697796e08a2c21de79015fe702ae334d60bcdb186666",
      robots: "noindex, follow",
    },
    cookies: {
      path: "/cookies",
      hash: "ee5670e2d1d0b01781cfb900767088c47072846458feded77d8f38ee56e18ff9",
      robots: "noindex, nofollow",
    },
    legal: {
      path: "/aviso-legal",
      hash: "6d82538f1697e797817181b35a75a8b1659dd8f90af20c69ef4025076440af7f",
      robots: "noindex, nofollow",
    },
    terms: {
      path: "/terminos-y-condiciones",
      hash: "7ba69cffb27e230e8f12b54f3c44f35c0a5d06ccf188f19785cc379c9943c4d8",
      robots: "noindex, nofollow",
    },
  };

  for (const [key, contract] of Object.entries(expected)) {
    const document = documents[key];
    const response = await renderPath(contract.path);
    const html = await response.text();
    const content = html.match(
      /<div class="legal-document-content">([\s\S]*?)<\/div>/,
    )?.[1];

    assert.equal(response.status, 200);
    assert.ok(content, `${contract.path} debe renderizar el documento`);
    assert.equal(document.normalizedTextSha256, contract.hash);
    assert.match(
      html,
      new RegExp(`data-source-hash="${contract.hash}"`),
    );
    assert.match(
      html,
      new RegExp(
        `<meta name="robots" content="${contract.robots.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}"`,
      ),
    );
    assert.doesNotMatch(html, /rel="canonical"/);

    const normalized = normalizeLegalHtml(document.title, content);
    assert.equal(normalized.length, document.normalizedTextLength);
    assert.equal(
      createHash("sha256").update(normalized).digest("hex"),
      contract.hash,
    );

    for (const path of [
      "/politica-privacidad",
      "/cookies",
      "/aviso-legal",
      "/terminos-y-condiciones",
    ]) {
      assert.match(html, new RegExp(`href="${path}"`));
    }
    assert.match(html, />Configurar cookies<\/button>/);
  }
});

contractTest("does not load analytics before consent and exposes cookie settings", async () => {
  const response = await renderPath();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /<script[^>]+googletagmanager\.com/i);
  assert.match(html, /Configurar cookies/);
  assert.match(html, /href="\/politica-privacidad"/);
  assert.match(html, /href="\/cookies"/);
  assert.match(html, /href="\/aviso-legal"/);
  assert.match(html, /href="\/terminos-y-condiciones"/);
  assert.doesNotMatch(
    html,
    /href="https:\/\/comunidadsolar\.es\/(?:politica-privacidad|cookies|aviso-legal|terminos-y-condiciones)/,
  );
});

contractTest("uses the analytics-only property instead of the legacy marketing container", async () => {
  const source = await readMigratedSource("consent");

  assert.doesNotMatch(source, /GTM-WJQLQ6P/);
  assert.match(source, /G-EE5NXKDT7G/);
  assert.match(source, /ad_storage:\s*"denied"/);
  assert.match(source, /choice !== "analytics"/);
  assert.match(source, /href="\/cookies"/);
  assert.match(source, /Rechazar analítica/);
  assert.match(source, /Aceptar analítica/);
});

contractTest("publishes one curated public hub for Backstage and TrainerCentral events", async () => {
  const response = await renderPath("/eventos");
  const blog = await renderPath("/blog");
  const sitemap = await renderPath("/sitemap.xml");
  const html = await response.text();
  const blogHtml = await blog.text();
  const sitemapXml = await sitemap.text();

  assert.equal(response.status, 200);
  assert.match(
    html,
    /rel="canonical" href="https:\/\/comunidadsolar\.es\/eventos"/,
  );
  assert.match(
    sitemapXml,
    /<loc>https:\/\/comunidadsolar\.es\/eventos<\/loc>/,
  );
  assert.match(
    html,
    /La energía se entiende mejor cuando la compartimos\./,
  );
  assert.match(html, /Próximos eventos/);
  assert.match(html, /Eventos anteriores/);
  assert.match(html, /Ahora mismo no hay ningún evento abierto\./);
  assert.match(html, /Agenda revisada · (?:<!-- -->)?28 julio 2026/);
  assert.match(html, /Zoho Backstage/);
  assert.match(html, /Zoho TrainerCentral/);
  assert.match(html, /Fuente Álamo volvió a abrir sus puertas/);
  assert.match(html, /Webinar sobre la campaña de crowdequity/);
  assert.match(html, /Un Solsticio para aprender, probar y celebrar/);
  assert.match(html, /El quinto aniversario volvió a reunir a la comunidad/);
  assert.match(
    html,
    /https:\/\/eventos\.comunidadsolar\.es\/VisitaParqueAutoconsumoRemoto15denoviembre/,
  );
  assert.match(
    html,
    /https:\/\/comunidadsolar\.trainercentralsite\.eu\/session\/webinar-crowdequity-585481681/,
  );
  assert.equal(
    (html.match(/data-event-status="celebrado"/g) ?? []).length,
    3,
    "El último evento aparece destacado y los tres restantes forman el archivo",
  );
  assert.doesNotMatch(
    html,
    /webinar-business-plan-comunidad-solar|webinar-exclusivo-para-socios|webinar-especial-para-socios|inversores-de-crowdcube/i,
  );
  assert.match(blogHtml, /href="\/eventos"[\s\S]{0,100}Ver eventos/);
  assert.doesNotMatch(
    blogHtml,
    /href="https:\/\/eventos\.comunidadsolar\.es\/events\?type=completed"[\s\S]{0,100}Ver eventos/,
  );
});

contractTest("temporarily hides events from the main menu while preserving secondary access", async () => {
  const home = await renderPath("/");
  const html = await home.text();
  const desktopNav = html.match(
    /<nav class="desktop-nav"[\s\S]*?<\/nav>/,
  )?.[0];
  const mobileNav = html.match(
    /<nav(?=[^>]*id="mobile-menu")[^>]*>[\s\S]*?<\/nav>/,
  )?.[0];

  assert.equal(home.status, 200);
  assert.ok(desktopNav);
  assert.ok(mobileNav);
  assert.doesNotMatch(desktopNav, /href="\/eventos"/);
  assert.doesNotMatch(mobileNav, /href="\/eventos"/);
  assert.match(html, /<footer[\s\S]*?href="\/eventos"[\s\S]*?<\/footer>/);
});

for (const [path, currentHref] of [
  ["/comunidades-energeticas", "/comunidades-energeticas"],
  ["/autoconsumo-remoto", "/autoconsumo-remoto"],
  ["/rentabiliza-tu-activo", "/rentabiliza-tu-activo#cubierta"],
  [
    "/comunidades-energeticas-operativas",
    "/comunidades-energeticas-operativas",
  ],
  ["/soy-comunero", "/soy-comunero"],
]) {
  contractTest(`marks the current navigation destination on ${path}`, async () => {
    const response = await renderPath(path);
    const html = await response.text();
    const escapedHref = currentHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.equal(response.status, 200);
    assert.match(
      html,
      new RegExp(
        `<a(?=[^>]*href="${escapedHref}")(?=[^>]*aria-current="page")[^>]*>`,
      ),
    );
    assert.match(
      html,
      /<div(?=[^>]*id="contenido-principal")(?=[^>]*tabindex="-1")[^>]*>/,
    );
  });
}

for (const path of [
  "/subvenciones",
  "/gestionamos-subvenciones",
  "/gestionamos-subvenciones-placas-solares",
]) {
  contractTest(`retires the legacy subsidy route ${path}`, async () => {
    const response = await renderPath(path);

    assert.equal(response.status, 410);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
  });
}

contractTest("redirects the legacy maintenance route", async () => {
  const response = await renderPath("/mantenimiento-placas-solares");

  assert.equal(response.status, 308);
  assert.match(response.headers.get("location") ?? "", /\/mantenimiento$/);
});

for (const path of [
  "/",
  "/contacto",
  "/comercializadora-y-tarifas",
  "/autoconsumo-remoto",
  "/eventos",
  "/rentabiliza-tu-activo",
  "/comunidades-energeticas-operativas",
]) {
  contractTest(`keeps the approved route ${path} available`, async () => {
    const response = await renderPath(path);
    assert.equal(response.status, 200);
  });
}

contractTest("publishes the complete operating-plant partnership page", async () => {
  const response = await renderPath("/comunidades-energeticas-operativas");
  const html = await response.text();
  const sitemap = await renderPath("/sitemap.xml");
  const sitemapXml = await sitemap.text();
  const siteSource = await readMigratedSource("site");

  assert.equal(response.status, 200);
  assert.match(
    html,
    /rel="canonical" href="https:\/\/comunidadsolar\.es\/comunidades-energeticas-operativas"/,
  );
  assert.match(
    sitemapXml,
    /https:\/\/comunidadsolar\.es\/comunidades-energeticas-operativas/,
  );
  assert.match(html, /class="topline"/);
  assert.match(html, /src="\/comunidad-solar-logo\.svg"/);
  assert.match(
    html,
    /\/media\/hero-operativas-red-de-valor-clean-1024x792\.png/,
  );
  assert.match(html, /Activo que ya produce/);
  assert.match(html, /Plataforma y comercializadora/);
  assert.match(html, /Demanda de proximidad/);
  assert.match(html, /Tu planta ya produce/);
  assert.match(html, /Mercado/);
  assert.match(html, /PPA/);
  assert.match(html, /Venta del activo/);
  assert.match(html, /Cada parte aporta lo que sabe hacer/);
  assert.match(html, /80% para el propietario y 20% para Comunidad Solar/);
  assert.match(html, /ingresos efectivamente cobrados/);
  assert.match(html, /La planta operativa y su mantenimiento/);
  assert.match(html, /La plataforma, la comercialización y la venta/);
  assert.match(html, /No necesitas montar una comercializadora/);
  assert.match(html, /La plataforma que conecta la planta, los usuarios y la factura/);
  assert.match(html, /Del primer análisis a una comunidad funcionando/);
  assert.match(html, /personas que conocen el proyecto/);
  assert.doesNotMatch(html, /informe que termina en un cajón/i);
  assert.match(html, /El propietario conserva el activo/);
  assert.match(html, /Conversión total o parcial/);
  assert.match(html, /Buscamos\s+proyectos maduros, no ideas preliminares/);
  assert.match(html, /titularidad o derecho de explotación/);
  assert.match(
    html,
    /concentrar el análisis en proyectos serios y no hacer perder tiempo ni esfuerzo/,
  );
  assert.match(html, /EVALUACIÓN DE ENCAJE · ACTIVOS DOCUMENTADOS/);
  assert.match(html, /Tomás Bensadón/);
  assert.match(html, /Gestor de Comunidades Energéticas/);
  assert.match(html, /\/media\/tomas-bensadon\.png/);
  assert.match(html, /Kike Sáenz/);
  assert.match(html, /\/media\/kike-saenz\.png/);
  assert.match(html, /mailto:enrique@comunidadsolar\.es/);
  assert.match(html, /operational_kike_meeting_request/);
  assert.match(html, /operational_kike_email_click/);
  assert.match(html, /operational_tomas_meeting_request/);
  assert.match(html, /operational_tomas_phone_click/);
  assert.match(html, /operational_tomas_email_click/);
  assert.match(html, /mailto:tomas\.bensadon@comunidadsolar\.es/);
  assert.match(html, /tel:\+34603958158/);
  assert.match(html, /operational_plant_study_open/);
  assert.match(html, /aria-controls="formulario-planta"/);
  assert.match(
    html,
    /forms\.zohopublic\.eu\/comunidadsolar\/form\/ProyectosCEListosparagestionarV2/,
  );
  assert.match(siteSource, /function OperationalPlantFormEmbed/);
  assert.match(
    siteSource,
    /referrername=web-comunidades-energeticas-operativas/,
  );
  assert.match(
    siteSource,
    /title="Formulario para analizar una planta fotovoltaica operativa"/,
  );
  assert.match(
    siteSource,
    /data-analytics-event="operational_plant_form_external_fallback"/,
  );
  assert.doesNotMatch(
    html,
    /multiplica el valor|ingresos garantizados|ocupación asegurada/i,
  );
  assert.doesNotMatch(html, /oportunidad llegue ya ordenada al equipo/i);

  const assetsPage = await renderPath("/rentabiliza-tu-activo");
  const assetsHtml = await assetsPage.text();

  assert.equal(assetsPage.status, 200);
  assert.match(
    assetsHtml,
    /Titularidad, documentación técnica, potencia, producción/,
  );
  assert.doesNotMatch(assetsHtml, /datos básicos de producción/i);
  assert.match(
    assetsHtml,
    /href="\/comunidades-energeticas-operativas#formulario-planta"/,
  );

  for (const sourcePath of ["/", "/rentabiliza-tu-activo"]) {
    const source = await renderPath(sourcePath);
    const sourceHtml = await source.text();

    assert.equal(source.status, 200);
    assert.match(
      sourceHtml,
      /href="\/comunidades-energeticas-operativas"/,
    );
  }
});

for (const [slug, name, action] of [
  ["torrontera", "Torrontera I y II", "Calcular mi propuesta"],
  ["fuente-alamo", "Fuente Álamo I y II", "Entrar en mi app"],
  ["liguerzana", "Ligüérzana · Central del Pisuerga", "Entrar en mi app"],
]) {
  contractTest(`renders the ${slug} remote project page`, async () => {
    const response = await renderPath(`/autoconsumo-remoto/${slug}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, new RegExp(name));
    assert.match(
      html,
      slug === "fuente-alamo"
        ? /Disponibilidad comercial/
        : slug === "torrontera"
          ? /Plazas de Torrontera/
          : /Nuevas plazas/,
    );
    assert.match(html, /CÓMO FUNCIONA/);
    assert.match(html, new RegExp(action));
  });
}
