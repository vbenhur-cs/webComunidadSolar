export type CommunityStatusTone = "active" | "progress" | "planning";
export type CommunityMilestoneState = "done" | "current" | "next";

export type CommunityMilestone = {
  title: string;
  copy: string;
  state: CommunityMilestoneState;
};

export type CommunityActivationStatus = {
  connection: {
    value: string;
    detail: string;
    tone: "done" | "current";
  };
  billing: {
    value: string;
    detail: string;
    tone: "done" | "current";
  };
};

export type CommunityInstallation = {
  name: string;
  address?: string;
  panelCount: number;
  panelPowerW: number;
  powerKwp: number;
  contractedPanels?: number;
  registeredParticipants?: number;
  pricePerPanel?: number;
  coefficientPercent?: number;
  commercialStatus: string;
  technicalStatus?: string;
  energyStatus?: string;
  updatedAt?: string;
};

export type CommunityEditorial = {
  heroImage?: string;
  heroImageAlt?: string;
  energySummary: string;
  introTitle: string;
  introCopy: string;
  storyEyebrow: string;
  storyTitle: string;
  storyCopy: string[];
  storyImage: string;
  storyImageAlt: string;
  updatesUrl: string;
};

export type CommunityNetworkStats = {
  municipalities: number;
  installations: number;
  panelCount: number;
  powerKwp: number;
};

export type Community = {
  slug: string;
  kind?: "community" | "network";
  networkSlug?: string;
  name: string;
  municipality: string;
  province: string;
  region: string;
  image: string;
  imageAlt: string;
  imageCredit?: {
    label: string;
    href: string;
    license?: string;
  };
  status: string;
  statusTone: CommunityStatusTone;
  summary: string;
  stateHeadline: string;
  stateCopy: string;
  updatedAt: string;
  nextAction: string;
  modalities: string[];
  power: string;
  estimatedParticipants: string;
  term: string;
  radius: string;
  host: string;
  overview?: string[];
  commercialStatus?: string;
  commercialDataAt?: string;
  projectType?: "Municipal" | "Privada";
  installations?: CommunityInstallation[];
  networkStats?: CommunityNetworkStats;
  dataCaveat?: string;
  activationStatus?: CommunityActivationStatus;
  editorial?: CommunityEditorial;
  map: {
    x: number;
    y: number;
  };
  milestones: CommunityMilestone[];
  sourceUrl: string;
};

const coreCommunities: Community[] = [
  {
    slug: "villaverde-getafe",
    name: "Villaverde / Getafe",
    municipality: "Villaverde y Getafe",
    province: "Madrid",
    region: "Comunidad de Madrid",
    image: "/media/villaverde-getafe.jpg",
    imageAlt:
      "Vista urbana de Villaverde y Getafe, área de cobertura de la comunidad energética",
    status: "Planta conectada · reparto pendiente",
    statusTone: "progress",
    summary:
      "La planta de 48 kWp de la cubierta de Incomer ya está conectada a la red. La energía aún no se refleja en las facturas de los comuneros de Villaverde y Getafe.",
    stateHeadline:
      "La planta está conectada, pero los comuneros aún no reciben la energía.",
    stateCopy:
      "La conexión de la planta y la activación de los coeficientes de reparto son dos hitos distintos. La comercializadora de Comunidad Solar está gestionando ante la distribuidora su legalización; hasta que concluya ese trámite, la energía todavía no aparecerá en las facturas de los comuneros.",
    updatedAt: "Julio de 2026",
    nextAction: "Completar la legalización de los coeficientes de reparto",
    modalities: ["Compra"],
    power: "47,80 kWp",
    estimatedParticipants: "20",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Cubierta de Incomer",
    overview: [
      "La instalación se encuentra sobre la cubierta de Incomer, en la calle Valle de Tobalina 14 del polígono empresarial de Villaverde. Su radio de proximidad alcanza suministros compatibles de Villaverde y Getafe.",
      "La comunidad es de iniciativa privada y funciona mediante compra de paneles. La planta ya está conectada a la red, pero la asignación de energía a los comuneros continúa pendiente de la activación de los coeficientes de reparto.",
    ],
    commercialStatus: "Plazas disponibles",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Privada",
    installations: [
      {
        name: "Villaverde · Incomer",
        address: "Calle Valle de Tobalina 14, Villaverde, Madrid",
        panelCount: 79,
        panelPowerW: 605,
        powerKwp: 47.795,
        contractedPanels: 13,
        registeredParticipants: 1,
        pricePerPanel: 799.03,
        coefficientPercent: 1.2658,
        commercialStatus: "Plazas disponibles",
        technicalStatus: "Conectada a la red",
      },
    ],
    activationStatus: {
      connection: {
        value: "Conectada a la red",
        detail: "Planta de la cubierta de Incomer",
        tone: "done",
      },
      billing: {
        value: "Pendiente",
        detail: "Los comuneros aún no reciben energía en factura",
        tone: "current",
      },
    },
    map: { x: 46, y: 46 },
    milestones: [
      {
        title: "Cubierta incorporada",
        copy: "Incomer cede el espacio desde el que se genera la energía local.",
        state: "done",
      },
      {
        title: "Planta conectada",
        copy: "La instalación de 48 kWp ya está conectada a la red.",
        state: "done",
      },
      {
        title: "Coeficientes de reparto",
        copy: "La comercializadora de Comunidad Solar tramita su legalización ante la distribuidora.",
        state: "current",
      },
      {
        title: "Primeras facturas",
        copy: "La energía se reflejará en las facturas cuando el reparto quede activado.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-villaverde/",
  },
  {
    slug: "nuevo-baztan",
    name: "Nuevo Baztán",
    municipality: "Nuevo Baztán",
    province: "Madrid",
    region: "Comunidad de Madrid",
    image: "/media/nuevo-baztan.jpeg",
    imageAlt:
      "Vista aérea del casco histórico de Nuevo Baztán y su entorno",
    status: "Instalación avanzada",
    statusTone: "progress",
    summary:
      "Tres cubiertas municipales para que vecinos y empresas compartan energía solar sin instalar paneles en casa. Las instalaciones avanzan por fases y todavía hay plazas.",
    stateHeadline: "Las instalaciones están ejecutadas o en su tramo final.",
    stateCopy:
      "La nave municipal sigue pendiente del cierre del expediente con la distribuidora. En el colegio, la instalación y la conexión están terminadas y queda la inspección final para completar el proceso.",
    updatedAt: "Julio de 2026",
    nextAction: "Cerrar los trámites finales con la distribuidora",
    modalities: ["Compra"],
    power: "285,45 kWp",
    estimatedParticipants: "114",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Cubiertas municipales",
    overview: [
      "El Ayuntamiento de Nuevo Baztán aporta tres cubiertas municipales: la nave del entorno del Punto Limpio y las zonas norte y sur del Colegio Juan de Goyeneche.",
      "La primera cubierta está prácticamente completa y las dos instalaciones del colegio todavía tienen plazas disponibles. Cada cubierta avanza a su propio ritmo, por eso te mostramos su situación por separado.",
      "El proyecto nació en 2024 con prioridad para los vecinos afectados por el entorno BIC y publicó una bonificación del 50% del IBI durante cuatro años como incentivo municipal histórico.",
    ],
    commercialStatus: "Plazas disponibles",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    editorial: {
      energySummary: "Energía pendiente de activación",
      introTitle:
        "Tres cubiertas municipales para compartir energía solar en Nuevo Baztán.",
      introCopy:
        "El Ayuntamiento aporta las cubiertas de la nave municipal y del Colegio Juan de Goyeneche. Tú participas en la instalación que puede dar cobertura a tu dirección y recibes en tu factura la parte de producción que te corresponde.",
      storyEyebrow: "Un proyecto de todo el municipio",
      storyTitle:
        "La nave y el colegio construyen la energía compartida de Nuevo Baztán.",
      storyCopy: [
        "La comunidad nació con el impulso del Ayuntamiento y la participación de los vecinos. La nave municipal fue la primera fase y el colegio amplió después la capacidad del proyecto.",
        "Cada cubierta mantiene su propio expediente y su propio estado. Por eso te contamos por separado qué está terminado, qué queda pendiente y dónde siguen existiendo plazas.",
      ],
      storyImage: "/media/blog-nuevo-baztan-detalle.jpg",
      storyImageAlt:
        "Vecinos de Nuevo Baztán participando en una jornada de la comunidad energética",
      updatesUrl:
        "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/comunidad-energ%C3%A9tica-de-nuevo-bazt%C3%A1n-avances-y-novedades",
    },
    installations: [
      {
        name: "Nave Municipal",
        address: "Entorno del Punto Limpio de Nuevo Baztán",
        panelCount: 117,
        panelPowerW: 550,
        powerKwp: 64.35,
        contractedPanels: 116,
        registeredParticipants: 18,
        pricePerPanel: 659.2,
        coefficientPercent: 0.8547,
        commercialStatus: "Última plaza disponible",
        technicalStatus: "Instalación terminada · expediente con UFD pendiente",
        energyStatus: "La energía todavía no aparece en factura",
        updatedAt: "Julio de 2026",
      },
      {
        name: "Colegio Juan de Goyeneche · zona norte",
        address: "Avenida Glasgow 1, Nuevo Baztán",
        panelCount: 176,
        panelPowerW: 550,
        powerKwp: 96.8,
        contractedPanels: 19,
        registeredParticipants: 1,
        pricePerPanel: 659.2,
        coefficientPercent: 0.56818,
        commercialStatus: "Plazas disponibles",
        technicalStatus:
          "Instalación y conexión terminadas · inspección final pendiente",
        energyStatus: "La energía todavía no aparece en factura",
        updatedAt: "Julio de 2026",
      },
      {
        name: "Colegio Juan de Goyeneche · zona sur",
        address: "Avenida Glasgow 1, Nuevo Baztán",
        panelCount: 226,
        panelPowerW: 550,
        powerKwp: 124.3,
        contractedPanels: 78,
        registeredParticipants: 12,
        pricePerPanel: 659.2,
        coefficientPercent: 0.44248,
        commercialStatus: "Plazas disponibles",
        technicalStatus:
          "Instalación y conexión terminadas · inspección final pendiente",
        energyStatus: "La energía todavía no aparece en factura",
        updatedAt: "Julio de 2026",
      },
    ],
    map: { x: 53, y: 46 },
    milestones: [
      {
        title: "19 abr 2024 · Lanzamiento",
        copy: "Ayuntamiento y Comunidad Solar presentan la comunidad energética.",
        state: "done",
      },
      {
        title: "18 jul 2024 · Reservas",
        copy: "Comienza la reserva de participaciones para vecinos y empresas.",
        state: "done",
      },
      {
        title: "1 oct 2024 · Primera cubierta",
        copy: "La primera fase se completa con 29 familias y se anuncian nuevas fases.",
        state: "done",
      },
      {
        title: "19 feb 2025 · Patrimonio",
        copy: "La actuación obtiene la aprobación necesaria por el entorno protegido.",
        state: "done",
      },
      {
        title: "28 abr 2025 · Obra",
        copy: "La nave alcanza 116 paneles y avanzan las dos zonas del colegio.",
        state: "done",
      },
      {
        title: "28 ago 2025 · OCA",
        copy: "La nave supera la OCA y el colegio entra en el tramo final de legalización.",
        state: "done",
      },
      {
        title: "4 jun 2026 · Dos expedientes",
        copy: "La nave espera respuesta de UFD; el colegio está conectado y pendiente de inspección final.",
        state: "current",
      },
      {
        title: "Coeficientes de reparto",
        copy: "La energía comenzará a asignarse cuando la distribuidora active los coeficientes.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-nuevo-baztan/",
  },
  {
    slug: "ceuti",
    name: "Ceutí",
    municipality: "Ceutí",
    province: "Murcia",
    region: "Región de Murcia",
    image: "/media/ceuti.jpg",
    imageAlt: "Vista del municipio de Ceutí, en la Región de Murcia",
    status: "Legalización final",
    statusTone: "progress",
    summary:
      "La instalación está terminada y supera la inspección principal; queda completar la protección adicional y el cierre con la distribuidora.",
    stateHeadline: "La planta está construida y en la última fase técnica.",
    stateCopy:
      "La instalación está terminada y ha superado la inspección OCA. Las características del punto de conexión exigen protecciones adicionales antes de la comprobación final de la distribuidora y el inicio de la comercialización.",
    updatedAt: "Julio de 2026",
    nextAction: "Instalar protecciones y solicitar la comprobación final",
    modalities: ["Compra"],
    power: "120,12 kWp",
    estimatedParticipants: "60",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Complejo Deportivo Antonio Peñalver",
    overview: [
      "El Ayuntamiento de Ceutí aporta la cubierta del Complejo Deportivo Antonio Peñalver, en la calle Saura Mira 6, para una comunidad municipal de compra.",
      "El diseño definitivo se ajustó en diciembre de 2025 a 182 paneles de 660 W, manteniendo una potencia total aproximada de 120 kWp. La instalación está terminada y ha superado la inspección OCA.",
      "Antes de iniciar la asignación de energía deben completarse las protecciones adicionales, la legalización específica del punto de conexión y la comprobación final de la distribuidora.",
    ],
    commercialStatus: "Plazas disponibles",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    installations: [
      {
        name: "Complejo Deportivo Antonio Peñalver",
        address: "Calle Saura Mira 6, Ceutí, Murcia",
        panelCount: 182,
        panelPowerW: 660,
        powerKwp: 120.12,
        contractedPanels: 65,
        registeredParticipants: 7,
        pricePerPanel: 757.96,
        coefficientPercent: 0.54945,
        commercialStatus: "Plazas disponibles",
        technicalStatus: "Instalada · inspección OCA superada",
      },
    ],
    map: { x: 70, y: 69 },
    milestones: [
      {
        title: "11 dic 2025 · Diseño definitivo",
        copy: "El proyecto queda definido en 182 paneles de 660 W y 120,12 kWp.",
        state: "done",
      },
      {
        title: "12 dic 2025 · Presentación",
        copy: "Se presenta oficialmente la comunidad y se abren las reservas.",
        state: "done",
      },
      {
        title: "12 ene 2026 · Instalación",
        copy: "La planta queda terminada y su documentación se envía a la OCA.",
        state: "done",
      },
      {
        title: "30 jun 2026 · OCA",
        copy: "La instalación supera la inspección OCA y entra en la fase adicional del punto de conexión.",
        state: "done",
      },
      {
        title: "Protecciones adicionales",
        copy: "Se completa la solución específica exigida por el punto de conexión.",
        state: "current",
      },
      {
        title: "Comercialización",
        copy: "Tras la comprobación final comenzará la asignación de energía.",
        state: "next",
      },
    ],
    sourceUrl: "https://comunidadsolar.es/ce-ceuti/",
  },
  {
    slug: "villalbilla",
    name: "Villalbilla",
    municipality: "Villalbilla",
    province: "Madrid",
    region: "Comunidad de Madrid",
    image: "/media/villalbilla.jpg",
    imageAlt: "Vista aérea del municipio madrileño de Villalbilla",
    status: "Energía ya reflejada en factura",
    statusTone: "active",
    summary:
      "Energía solar producida en dos colegios municipales, sin instalar nada en casa. La primera cubierta ya está activa y todavía quedan plazas en el proyecto.",
    stateHeadline:
      "Conectada desde 2025; la energía ya empieza a reflejarse en las facturas.",
    stateCopy:
      "La instalación del colegio Gregorio Canella se conectó a la red en 2025. Tras completar la tramitación de los coeficientes de reparto, desde julio de 2026 los comuneros están empezando a recibir las primeras facturas en las que aparece la producción asignada. La instalación del colegio Salvador Dalí continúa como ampliación del proyecto.",
    updatedAt: "Julio de 2026",
    nextAction:
      "Seguir las primeras facturas y completar la ampliación de Salvador Dalí",
    modalities: ["Compra"],
    power: "255,31 kWp",
    estimatedParticipants: "93",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Colegios municipales",
    overview: [
      "La comunidad se desarrolla sobre dos centros educativos municipales: el Colegio Gregorio Canella y el CEIP Salvador Dalí, en Los Hueros.",
      "Gregorio Canella terminó su obra en octubre de 2025, superó la inspección OCA en diciembre y se conectó a la red ese mismo año. Desde julio de 2026, los primeros comuneros están recibiendo facturas con la energía asignada.",
      "Salvador Dalí amplía la capacidad del proyecto. Sus plazas y su avance se muestran por separado porque las dos cubiertas se encuentran en fases diferentes.",
    ],
    commercialStatus: "Plazas disponibles",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    editorial: {
      heroImage: "/media/villalbilla-gregorio-canella-cubierta.jpg",
      heroImageAlt:
        "Paneles solares instalados en la cubierta del colegio Gregorio Canella de Villalbilla",
      energySummary: "1 cubierta ya refleja energía en factura",
      introTitle:
        "Energía solar de Villalbilla, compartida sin hacer obras en tu tejado.",
      introCopy:
        "El Ayuntamiento aporta las cubiertas de los colegios Gregorio Canella y Salvador Dalí. Tú participas en la instalación que da cobertura a tu dirección y recibes en tu factura la producción asignada a tus paneles.",
      storyEyebrow: "De proyecto local a energía real",
      storyTitle:
        "De la presentación a los vecinos a las primeras facturas con energía de Villalbilla.",
      storyCopy: [
        "La comunidad se presentó en enero de 2025 con el Ayuntamiento y los vecinos. Ese mismo año terminó la instalación de Gregorio Canella, superó la inspección y quedó conectada a la red.",
        "Desde julio de 2026, los primeros comuneros ya reciben facturas con la energía asignada. Salvador Dalí amplía ahora la capacidad para que puedan incorporarse más hogares y negocios.",
      ],
      storyImage: "/media/blog-villalbilla-evento.jpg",
      storyImageAlt:
        "Vecinos durante la presentación de la Comunidad Energética de Villalbilla",
      updatesUrl:
        "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/villalbilla-da-un-paso-hacia-la-sostenibilidad-%C3%A9xito-en-el-evento-de-presentaci%C3%B3n-de-su-comunidad-energ%C3%A9tica",
    },
    installations: [
      {
        name: "Colegio Gregorio Canella",
        address: "Carretera de Valdeláguila s/n, Villalbilla",
        panelCount: 215,
        panelPowerW: 605,
        powerKwp: 130.075,
        contractedPanels: 148,
        registeredParticipants: 29,
        pricePerPanel: 710,
        coefficientPercent: 0.4651,
        commercialStatus: "Plazas disponibles",
        technicalStatus: "Conectada a la red desde 2025",
        energyStatus: "Energía reflejada en las primeras facturas",
        updatedAt: "Julio de 2026",
      },
      {
        name: "CEIP Salvador Dalí",
        address: "Calle Salvador Dalí 8, Los Hueros, Villalbilla",
        panelCount: 207,
        panelPowerW: 605,
        powerKwp: 125.235,
        contractedPanels: 197,
        registeredParticipants: 39,
        pricePerPanel: 710,
        coefficientPercent: 0.48309,
        commercialStatus: "Últimas plazas disponibles",
        technicalStatus: "Ampliación del proyecto",
        energyStatus: "Pendiente de activación",
        updatedAt: "Julio de 2026",
      },
    ],
    activationStatus: {
      connection: {
        value: "Conectada a la red",
        detail: "Gregorio Canella · 2025",
        tone: "done",
      },
      billing: {
        value: "Activa",
        detail: "Primeras facturas con energía · julio de 2026",
        tone: "done",
      },
    },
    map: { x: 50, y: 43 },
    milestones: [
      {
        title: "24 ene 2025 · Presentación",
        copy: "El Ayuntamiento presenta la comunidad energética a los vecinos.",
        state: "done",
      },
      {
        title: "Jun 2025 · Inicio de obra",
        copy: "Comienza la instalación fotovoltaica de Gregorio Canella.",
        state: "done",
      },
      {
        title: "28 ago 2025 · 45% instalado",
        copy: "La obra avanza tras adaptar el trabajo a las condiciones de las cubiertas.",
        state: "done",
      },
      {
        title: "20 oct 2025 · Obra terminada",
        copy: "Finaliza la instalación del Colegio Gregorio Canella.",
        state: "done",
      },
      {
        title: "9 dic 2025 · OCA superada",
        copy: "La instalación supera la inspección y continúa su legalización.",
        state: "done",
      },
      {
        title: "2025 · Conexión a red",
        copy: "Gregorio Canella queda conectada a la red eléctrica.",
        state: "done",
      },
      {
        title: "Jul 2026 · Primeras facturas",
        copy: "Desde julio de 2026 la energía asignada empieza a aparecer en las facturas.",
        state: "current",
      },
      {
        title: "Ampliación Salvador Dalí",
        copy: "La segunda instalación amplía la capacidad local de la comunidad.",
        state: "current",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-villalbilla-madrid/",
  },
  {
    slug: "ibeas-de-juarros",
    name: "Ibeas de Juarros",
    municipality: "Ibeas de Juarros",
    province: "Burgos",
    region: "Castilla y León",
    image: "/media/ibeas-de-juarros.jpeg",
    imageAlt: "Vista de Ibeas de Juarros, en la provincia de Burgos",
    status: "Conexión final pendiente",
    statusTone: "progress",
    summary:
      "La instalación principal está prácticamente terminada y espera la autorización necesaria para completar su conexión.",
    stateHeadline: "Los equipos principales ya están instalados.",
    stateCopy:
      "Paneles, inversores y equipos principales están colocados. El proyecto espera la autorización específica de la distribuidora para completar la conexión al cuadro general y pasar a legalización.",
    updatedAt: "Julio de 2026",
    nextAction: "Completar conexión y comenzar la legalización",
    modalities: ["Compra"],
    power: "93,72 kWp",
    estimatedParticipants: "39",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Cubierta municipal",
    overview: [
      "El Ayuntamiento de Ibeas de Juarros aporta la cubierta del Polideportivo Municipal, en la calle Polideportivo, para una comunidad municipal de compra.",
      "La instalación cuenta con 142 paneles de 660 W, equivalentes a 93,72 kWp. Los paneles, inversores y equipos principales ya están colocados; queda completar la conexión al cuadro general y comenzar la legalización.",
    ],
    commercialStatus: "Plazas disponibles",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    installations: [
      {
        name: "Polideportivo Municipal de Ibeas",
        address: "Calle Polideportivo, 09198 Ibeas de Juarros, Burgos",
        panelCount: 142,
        panelPowerW: 660,
        powerKwp: 93.72,
        contractedPanels: 54,
        registeredParticipants: 9,
        pricePerPanel: 692.94,
        commercialStatus: "Plazas disponibles",
        technicalStatus: "Conexión final pendiente",
      },
    ],
    map: { x: 50, y: 23 },
    milestones: [
      {
        title: "30 jul 2024 · Anuncio",
        copy: "El Ayuntamiento presenta públicamente el proyecto de comunidad energética.",
        state: "done",
      },
      {
        title: "21 ene 2025 · Contratación",
        copy: "Se abre la incorporación de vecinos al proyecto municipal.",
        state: "done",
      },
      {
        title: "3 jul 2026 · Equipos instalados",
        copy: "Paneles, inversores y equipos principales están prácticamente terminados.",
        state: "done",
      },
      {
        title: "Conexión final",
        copy: "Pendiente de la autorización específica de la distribuidora.",
        state: "current",
      },
      {
        title: "Legalización",
        copy: "Comenzará cuando quede completada la conexión al cuadro general.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-ibeas-de-juarros/",
  },
  {
    slug: "san-adrian-de-juarros",
    name: "San Adrián de Juarros",
    municipality: "San Adrián de Juarros",
    province: "Burgos",
    region: "Castilla y León",
    image: "/media/san-adrian-de-juarros.jpg",
    imageAlt: "Vista de San Adrián de Juarros, en Burgos",
    status: "Participación completa",
    statusTone: "progress",
    summary:
      "Una pequeña comunidad energética municipal para compartir energía solar en el entorno.",
    stateHeadline: "La comunidad no tiene plazas disponibles en este momento.",
    stateCopy:
      "Los 18 paneles previstos ya están asignados. Puedes comprobar tu dirección y pedir que te avisemos si se libera una plaza o si otra comunidad cercana puede darte cobertura.",
    updatedAt: "Julio de 2026",
    nextAction: "Consultar disponibilidad o lista de espera",
    modalities: ["Compra"],
    power: "10,80 kWp",
    estimatedParticipants: "5",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Cubierta municipal",
    overview: [
      "La instalación se sitúa sobre la Casa Consistorial de San Adrián de Juarros, en la calle La Sociedad 3, y forma una comunidad municipal de compra.",
      "Los 18 paneles están contratados, por lo que ahora mismo no quedan plazas disponibles. El avance de la instalación y el inicio de la energía en factura se comunicarán por separado cuando estén confirmados.",
    ],
    commercialStatus: "Participación completa",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    installations: [
      {
        name: "Casa Consistorial",
        address: "Calle La Sociedad 3, San Adrián de Juarros, Burgos",
        panelCount: 18,
        panelPowerW: 600,
        powerKwp: 10.8,
        contractedPanels: 18,
        registeredParticipants: 4,
        pricePerPanel: 922.38,
        coefficientPercent: 5.5556,
        commercialStatus: "Participación completa",
      },
    ],
    map: { x: 53, y: 26 },
    milestones: [
      {
        title: "Ago 2024 · Proyecto local",
        copy: "Se define la comunidad municipal sobre edificios de San Adrián de Juarros.",
        state: "done",
      },
      {
        title: "Casa Consistorial",
        copy: "La cubierta municipal reúne 18 paneles y 10,80 kWp de potencia.",
        state: "done",
      },
      {
        title: "Participación completa",
        copy: "Los 18 paneles están contratados y no quedan plazas disponibles.",
        state: "done",
      },
      {
        title: "Próxima actualización",
        copy: "Comunicaremos el siguiente avance cuando estén confirmadas la conexión y la activación de la energía.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-san-adrian-de-juarros/",
  },
  {
    slug: "sepulveda",
    name: "Sepúlveda",
    municipality: "Sepúlveda",
    province: "Segovia",
    region: "Castilla y León",
    image: "/media/sepulveda.webp",
    imageAlt: "Vista del municipio segoviano de Sepúlveda",
    status: "Participación aún no abierta",
    statusTone: "planning",
    summary:
      "Una comunidad municipal prevista sobre el Polideportivo Félix Arranz, con 150 paneles y 90 kWp de potencia.",
    stateHeadline: "La incorporación de participantes todavía no está abierta.",
    stateCopy:
      "El proyecto prevé 150 paneles de 600 W sobre el Polideportivo Félix Arranz. Te informaremos del calendario de obra, conexión y apertura cuando esté confirmado.",
    updatedAt: "Julio de 2026",
    nextAction: "Abrir la participación cuando el proyecto lo permita",
    modalities: ["Compra"],
    power: "90 kWp",
    estimatedParticipants: "Por confirmar",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Polideportivo Félix Arranz",
    overview: [
      "La comunidad utilizará la cubierta del Polideportivo Félix Arranz y permitirá participar mediante compra cuando se abra la incorporación.",
      "La instalación prevista tendrá 150 paneles de 600 W y una potencia conjunta de 90 kWp. La incorporación de participantes todavía no está abierta y el calendario técnico se comunicará cuando quede confirmado.",
    ],
    commercialStatus: "Participación aún no abierta",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    installations: [
      {
        name: "Polideportivo Félix Arranz",
        panelCount: 150,
        panelPowerW: 600,
        powerKwp: 90,
        contractedPanels: 0,
        registeredParticipants: 0,
        pricePerPanel: 692.66,
        coefficientPercent: 0.6667,
        commercialStatus: "Participación aún no abierta",
      },
    ],
    map: { x: 43, y: 35 },
    milestones: [
      {
        title: "Cubierta identificada",
        copy: "El proyecto se desarrollará sobre el Polideportivo Félix Arranz.",
        state: "done",
      },
      {
        title: "Capacidad prevista",
        copy: "La instalación prevé 150 paneles y una potencia total de 90 kWp.",
        state: "done",
      },
      {
        title: "Apertura comercial",
        copy: "La incorporación de participantes todavía no está abierta.",
        state: "current",
      },
      {
        title: "Calendario del proyecto",
        copy: "Te informaremos cuando estén confirmadas las fechas de obra y conexión.",
        state: "next",
      },
    ],
    sourceUrl: "https://comunidadsolar.es/comunidades-energeticas/",
  },
  {
    slug: "santa-cruz-de-paniagua",
    name: "Santa Cruz de Paniagua",
    municipality: "Santa Cruz de Paniagua",
    province: "Cáceres",
    region: "Extremadura",
    image: "/media/santa-cruz-de-paniagua.jpg",
    imageAlt: "Vista de Santa Cruz de Paniagua, en Cáceres",
    status: "Proyecto de proximidad",
    statusTone: "progress",
    summary:
      "Un proyecto municipal de 60 kWp para compartir energía solar con vecinos y empresas del entorno.",
    stateHeadline: "La comunidad está en lista de espera.",
    stateCopy:
      "El proyecto prevé una instalación de 60 kWp sobre una cubierta municipal. Antes de abrir la contratación confirmaremos las plazas, las condiciones y el calendario.",
    updatedAt: "Julio de 2026",
    nextAction: "Comprobar cobertura y disponibilidad actual",
    modalities: ["Compra"],
    power: "60 kWp",
    estimatedParticipants: "22",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Velatorio de Santa Cruz de Paniagua",
    overview: [
      "El Ayuntamiento de Santa Cruz de Paniagua aporta la cubierta del velatorio municipal para una comunidad de compra destinada a vecinos y empresas del entorno.",
      "El proyecto prevé 100 paneles de 600 W, equivalentes a 60 kWp. La participación se gestiona por ahora mediante lista de espera y el calendario técnico se confirmará antes de abrir la contratación.",
    ],
    commercialStatus: "Lista de espera",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Municipal",
    installations: [
      {
        name: "Velatorio de Santa Cruz de Paniagua",
        panelCount: 100,
        panelPowerW: 600,
        powerKwp: 60,
        contractedPanels: 0,
        registeredParticipants: 0,
        pricePerPanel: 772,
        coefficientPercent: 1,
        commercialStatus: "Lista de espera",
      },
    ],
    map: { x: 27, y: 51 },
    milestones: [
      {
        title: "Acuerdo municipal",
        copy: "El Ayuntamiento pone a disposición la cubierta del proyecto.",
        state: "done",
      },
      {
        title: "Proyecto definido",
        copy: "La potencia y la capacidad prevista ya están definidas.",
        state: "done",
      },
      {
        title: "Lista de espera",
        copy: "Puedes comprobar tu cobertura mientras se preparan las condiciones.",
        state: "current",
      },
      {
        title: "Calendario y condiciones",
        copy: "Confirmaremos las condiciones de participación y los próximos pasos antes de abrir la contratación.",
        state: "next",
      },
    ],
    sourceUrl: "https://comunidadsolar.es/santa-cruz-de-paniagua/",
  },
  {
    slug: "ontinyent",
    name: "Ontinyent – Dream Home Textil",
    municipality: "Ontinyent",
    province: "Valencia",
    region: "Comunitat Valenciana",
    image: "/media/comunidades/ontinyent-dream-home-textil.webp",
    imageAlt:
      "Simulación de paneles solares sobre la cubierta de Dream Home Textil en Ontinyent",
    status: "Instalación construida · lista de espera",
    statusTone: "planning",
    summary:
      "La instalación de Dream Home Textil ya está construida: 226 paneles y 135,60 kWp para compartir energía solar con hogares y negocios del entorno.",
    stateHeadline:
      "La instalación está construida y la comunidad permanece en lista de espera.",
    stateCopy:
      "La planta de Dream Home Textil está terminada. Antes de abrir la contratación confirmaremos la conexión, la activación del reparto y las condiciones de alquiler.",
    updatedAt: "29 de julio de 2026",
    nextAction: "Comprobar cobertura e inscribirse en la lista de espera",
    modalities: ["Alquiler"],
    power: "135,60 kWp",
    estimatedParticipants: "Por determinar",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Dream Home Textil",
    overview: [
      "Dream Home Textil aporta su cubierta industrial en Ontinyent para que hogares y negocios cercanos puedan acceder a energía solar compartida sin instalar paneles en su propio tejado.",
      "La instalación cuenta con 226 paneles de 600 W y 135,60 kWp. La participación se gestionará mediante alquiler cuando estén confirmadas las condiciones y el calendario de activación.",
    ],
    commercialStatus: "Lista de espera",
    commercialDataAt: "29 de julio de 2026",
    projectType: "Privada",
    installations: [
      {
        name: "Dream Home Textil",
        address:
          "Carretera Ermita Sant Josep Pla 13, 46870 Ontinyent, Valencia",
        panelCount: 226,
        panelPowerW: 600,
        powerKwp: 135.6,
        commercialStatus: "Lista de espera",
        technicalStatus: "Instalación construida",
        energyStatus: "Pendiente de conexión y activación en factura",
        updatedAt: "29 de julio de 2026",
      },
    ],
    map: { x: 75, y: 62 },
    milestones: [
      {
        title: "Cubierta incorporada",
        copy: "Dream Home Textil aporta la cubierta desde la que se compartirá la energía.",
        state: "done",
      },
      {
        title: "Instalación construida",
        copy: "Los 226 paneles y los equipos principales ya están instalados.",
        state: "done",
      },
      {
        title: "Lista de espera",
        copy: "Puedes comprobar tu cobertura y registrar tu interés mientras se preparan las condiciones.",
        state: "current",
      },
      {
        title: "Conexión y activación",
        copy: "Confirmaremos la puesta en marcha y la apertura comercial cuando concluyan los siguientes trámites.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-ontinyent/",
  },
  {
    slug: "escurial",
    name: "Escurial – Mármoles Jiménez",
    municipality: "Escurial",
    province: "Cáceres",
    region: "Extremadura",
    image: "/media/comunidades/escurial-marmoles-jimenez.webp",
    imageAlt:
      "Plaza de España de Escurial, localidad de la comunidad energética de Mármoles Jiménez",
    imageCredit: {
      label: "Fotografía: Adolfobrigido",
      href: "https://commons.wikimedia.org/wiki/File:Escurial-_10.jpg",
      license: "CC BY-SA 4.0",
    },
    status: "Instalación construida · lista de espera",
    statusTone: "planning",
    summary:
      "La instalación de Mármoles Jiménez ya está construida: 174 paneles y 109,62 kWp para compartir energía solar con hogares y negocios del entorno.",
    stateHeadline:
      "La instalación está construida y la comunidad permanece en lista de espera.",
    stateCopy:
      "La planta de Mármoles Jiménez está terminada. Antes de abrir la contratación confirmaremos la conexión, la activación del reparto y las condiciones de alquiler.",
    updatedAt: "29 de julio de 2026",
    nextAction: "Comprobar cobertura e inscribirse en la lista de espera",
    modalities: ["Alquiler"],
    power: "109,62 kWp",
    estimatedParticipants: "Por determinar",
    term: "25 años",
    radius: "Hasta 5 km*",
    host: "Mármoles Jiménez",
    overview: [
      "Mármoles Jiménez aporta su cubierta industrial en Escurial para que hogares y negocios cercanos puedan acceder a energía solar compartida sin instalar paneles en su propio tejado.",
      "La instalación cuenta con 174 paneles de 630 W y 109,62 kWp. La participación se gestionará mediante alquiler cuando estén confirmadas las condiciones y el calendario de activación.",
    ],
    commercialStatus: "Lista de espera",
    commercialDataAt: "29 de julio de 2026",
    projectType: "Privada",
    installations: [
      {
        name: "Mármoles Jiménez",
        address:
          "Carretera N-V, km 287,8, 10133 Escurial, Cáceres",
        panelCount: 174,
        panelPowerW: 630,
        powerKwp: 109.62,
        commercialStatus: "Lista de espera",
        technicalStatus: "Instalación construida",
        energyStatus: "Pendiente de conexión y activación en factura",
        updatedAt: "29 de julio de 2026",
      },
    ],
    map: { x: 29, y: 56 },
    milestones: [
      {
        title: "Cubierta incorporada",
        copy: "Mármoles Jiménez aporta la cubierta desde la que se compartirá la energía.",
        state: "done",
      },
      {
        title: "Instalación construida",
        copy: "Los 174 paneles y los equipos principales ya están instalados.",
        state: "done",
      },
      {
        title: "Lista de espera",
        copy: "Puedes comprobar tu cobertura y registrar tu interés mientras se preparan las condiciones.",
        state: "current",
      },
      {
        title: "Conexión y activación",
        copy: "Confirmaremos la puesta en marcha y la apertura comercial cuando concluyan los siguientes trámites.",
        state: "next",
      },
    ],
    sourceUrl: "https://comunidadsolar.es/comunidades-energeticas/",
  },
];

type ExtremaduraCommunitySeed = {
  slug: string;
  name: string;
  province: "Cáceres" | "Badajoz";
  image: string;
  imageAlt: string;
  map: { x: number; y: number };
  address?: string;
  power: string;
  powerKwp: number;
  panelCount: number;
  installations: Array<{
    name: string;
    panelCount: number;
    panelPowerW: number;
    powerKwp: number;
    address?: string;
  }>;
};

function createExtremaduraCommunity(
  seed: ExtremaduraCommunitySeed,
): Community {
  const plural =
    seed.installations.length === 1 ? "instalación" : "instalaciones";

  return {
    slug: seed.slug,
    networkSlug: "extremadura",
    name: seed.name,
    municipality: seed.name,
    province: seed.province,
    region: "Extremadura",
    image: seed.image,
    imageAlt: seed.imageAlt,
    status: "Lista de espera",
    statusTone: "planning",
    summary: `Estamos preparando la Comunidad Energética de ${seed.name}, con ${seed.panelCount.toLocaleString("es-ES")} paneles y ${seed.power} de potencia previstos en ${seed.installations.length} ${plural}.`,
    stateHeadline: "La comunidad está en lista de espera.",
    stateCopy:
      "El proyecto ya cuenta con una ubicación y una potencia previstas. La contratación se abrirá cuando estén confirmadas las condiciones económicas y el calendario de esta localidad.",
    updatedAt: "26 de julio de 2026",
    nextAction: "Comprobar cobertura e inscribirse en la lista de espera",
    modalities: ["Alquiler"],
    power: seed.power,
    estimatedParticipants: "Por determinar",
    term: "Según contrato",
    radius: "Hasta 5 km*",
    host:
      seed.installations.length === 1
        ? seed.address ?? `Proyecto de ${seed.name}`
        : `${seed.installations.length} instalaciones previstas en ${seed.name}`,
    overview: [
      `La comunidad de ${seed.name} forma parte de la red de diez localidades de la Comunidad Energética Extremeña. El proyecto contempla ${seed.panelCount.toLocaleString("es-ES")} paneles y ${seed.power} en ${seed.installations.length} ${plural}.`,
      seed.address
        ? `La generación se sitúa en ${seed.address}. La cobertura de cada suministro debe comprobarse por dirección antes de incorporarse.`
        : "La cobertura de cada suministro debe comprobarse por dirección antes de incorporarse.",
      "La participación se realizará mediante alquiler, sin compra inicial. La cuota y el ahorro estimado se confirmarán antes de abrir la contratación en esta localidad.",
    ],
    commercialStatus: "Lista de espera",
    commercialDataAt: "26 de julio de 2026",
    projectType: "Privada",
    installations: seed.installations.map((installation) => ({
      ...installation,
      address: installation.address ?? seed.address,
      commercialStatus: "Lista de espera",
    })),
    dataCaveat:
      "Las condiciones económicas y el calendario técnico se confirmarán para esta localidad antes de abrir la contratación.",
    map: seed.map,
    milestones: [
      {
        title: "Localidad confirmada",
        copy: `${seed.name} forma parte de la red regional de comunidades.`,
        state: "done",
      },
      {
        title: "Capacidad prevista",
        copy: `${seed.installations.length} ${plural}, ${seed.panelCount.toLocaleString("es-ES")} paneles y ${seed.power}.`,
        state: "done",
      },
      {
        title: "Lista de espera",
        copy: "La participación permanece en fase de lista de espera.",
        state: "current",
      },
      {
        title: "Calendario y condiciones",
        copy: "Te informaremos cuando estén confirmados para esta localidad.",
        state: "next",
      },
    ],
    sourceUrl:
      "https://comunidadsolar.es/comunidad-energetica-extremadura/",
  };
}

const extremaduraCommunities: Community[] = [
  createExtremaduraCommunity({
    slug: "merida",
    name: "Mérida",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/merida.webp",
    imageAlt:
      "Simulación de paneles solares sobre una de las cubiertas de la Comunidad Energética de Mérida",
    map: { x: 31, y: 60 },
    address: "Urbanización Terminal Transportes 3, 06800 Mérida",
    power: "495 kWp",
    powerKwp: 495,
    panelCount: 825,
    installations: [
      { name: "Mérida 1", panelCount: 208, panelPowerW: 600, powerKwp: 124.8 },
      { name: "Mérida 2", panelCount: 210, panelPowerW: 600, powerKwp: 126 },
      { name: "Mérida 3", panelCount: 189, panelPowerW: 600, powerKwp: 113.4 },
      { name: "Mérida 4", panelCount: 218, panelPowerW: 600, powerKwp: 130.8 },
    ],
  }),
  createExtremaduraCommunity({
    slug: "don-benito",
    name: "Don Benito",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/don-benito.webp",
    imageAlt:
      "Edificio histórico de la Plaza de España de Don Benito, localidad de la comunidad energética",
    map: { x: 38, y: 59 },
    address: "Calle Marinegra 11, Huerta Solar, 06400 Don Benito",
    power: "409,20 kWp",
    powerKwp: 409.2,
    panelCount: 620,
    installations: [
      { name: "Don Benito", panelCount: 620, panelPowerW: 660, powerKwp: 409.2 },
    ],
  }),
  createExtremaduraCommunity({
    slug: "navalmoral-de-la-mata",
    name: "Navalmoral de la Mata",
    province: "Cáceres",
    image: "/media/comunidades/extremadura/navalmoral-de-la-mata.webp",
    imageAlt:
      "Simulación de paneles solares en una cubierta de la Comunidad Energética de Navalmoral de la Mata",
    map: { x: 38, y: 47 },
    address: "Entorno de la ITV y Centro de Transportes, antigua N-V km 179",
    power: "152,32 kWp",
    powerKwp: 152.32,
    panelCount: 238,
    installations: [
      {
        name: "Navalmoral de la Mata · sur",
        panelCount: 40,
        panelPowerW: 640,
        powerKwp: 25.6,
      },
      {
        name: "Navalmoral de la Mata · norte",
        panelCount: 198,
        panelPowerW: 640,
        powerKwp: 126.72,
      },
    ],
  }),
  createExtremaduraCommunity({
    slug: "villafranca-de-los-barros",
    name: "Villafranca de los Barros",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/villafranca-de-los-barros.webp",
    imageAlt:
      "Simulación de paneles solares sobre una cubierta de la Comunidad Energética de Villafranca de los Barros",
    map: { x: 29, y: 68 },
    address: "Centro de servicios al transporte, N-630, 06220 Villafranca de los Barros",
    power: "136,56 kWp",
    powerKwp: 136.56,
    panelCount: 226,
    installations: [
      {
        name: "Villafranca de los Barros 1",
        panelCount: 202,
        panelPowerW: 600,
        powerKwp: 121.2,
      },
      {
        name: "Villafranca de los Barros 2",
        panelCount: 24,
        panelPowerW: 640,
        powerKwp: 15.36,
      },
    ],
  }),
  createExtremaduraCommunity({
    slug: "jerez-de-los-caballeros",
    name: "Jerez de los Caballeros",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/jerez-de-los-caballeros.webp",
    imageAlt:
      "Calle de Jerez de los Caballeros con la torre de San Bartolomé al fondo",
    map: { x: 22, y: 73 },
    address: "Carretera de Zafra 3, 06380 Jerez de los Caballeros",
    power: "129,28 kWp",
    powerKwp: 129.28,
    panelCount: 202,
    installations: [
      {
        name: "Jerez de los Caballeros",
        panelCount: 202,
        panelPowerW: 640,
        powerKwp: 129.28,
      },
    ],
  }),
  createExtremaduraCommunity({
    slug: "almendralejo",
    name: "Almendralejo",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/almendralejo.webp",
    imageAlt:
      "Palacio de Monsalud, sede del Ayuntamiento de Almendralejo",
    map: { x: 30, y: 65 },
    address: "Centro de servicios al transporte del polígono industrial de Almendralejo",
    power: "117,12 kWp",
    powerKwp: 117.12,
    panelCount: 183,
    installations: [
      {
        name: "Almendralejo",
        panelCount: 183,
        panelPowerW: 640,
        powerKwp: 117.12,
      },
    ],
  }),
  createExtremaduraCommunity({
    slug: "coria",
    name: "Coria",
    province: "Cáceres",
    image: "/media/comunidades/extremadura/coria.webp",
    imageAlt: "Catedral de Santa María de la Asunción de Coria",
    map: { x: 27, y: 45 },
    address: "Urbanización Isla, 10800 Coria",
    power: "116,48 kWp",
    powerKwp: 116.48,
    panelCount: 182,
    installations: [
      { name: "Coria", panelCount: 182, panelPowerW: 640, powerKwp: 116.48 },
    ],
  }),
  createExtremaduraCommunity({
    slug: "caceres",
    name: "Cáceres",
    province: "Cáceres",
    image: "/media/comunidades/extremadura/caceres.webp",
    imageAlt: "Plaza Mayor y conjunto histórico de Cáceres",
    map: { x: 31, y: 51 },
    address: "Centro Superior Tecnológico de Cáceres",
    power: "105,60 kWp",
    powerKwp: 105.6,
    panelCount: 165,
    installations: [
      { name: "Cáceres", panelCount: 165, panelPowerW: 640, powerKwp: 105.6 },
    ],
  }),
  createExtremaduraCommunity({
    slug: "plasencia",
    name: "Plasencia",
    province: "Cáceres",
    image: "/media/comunidades/extremadura/plasencia.webp",
    imageAlt:
      "Simulación de paneles solares sobre las cubiertas de la Comunidad Energética de Plasencia",
    map: { x: 31, y: 42 },
    address: "Calle Goicoechea 26, 10600 Plasencia",
    power: "88,80 kWp",
    powerKwp: 88.8,
    panelCount: 148,
    installations: [
      { name: "Plasencia", panelCount: 148, panelPowerW: 600, powerKwp: 88.8 },
    ],
  }),
  createExtremaduraCommunity({
    slug: "zafra",
    name: "Zafra",
    province: "Badajoz",
    image: "/media/comunidades/extremadura/zafra.webp",
    imageAlt: "Soportales de la Plaza Grande de Zafra",
    map: { x: 34, y: 70 },
    power: "80,64 kWp",
    powerKwp: 80.64,
    panelCount: 126,
    installations: [
      { name: "Zafra", panelCount: 126, panelPowerW: 640, powerKwp: 80.64 },
    ],
  }),
];

const extremaduraNetwork: Community = {
  slug: "extremadura",
  kind: "network",
  name: "Comunidad Energética Extremeña",
  municipality: "10 localidades",
  province: "Cáceres y Badajoz",
  region: "Extremadura",
  image: "/media/extremadura.jpg",
  imageAlt:
    "Paisaje urbano extremeño dentro de la red regional de comunidades energéticas",
  status: "10 comunidades · lista de espera",
  statusTone: "planning",
  summary:
    "Una red de 10 comunidades locales con 15 instalaciones previstas, 2.915 paneles y 1.831 kWp de potencia en Cáceres y Badajoz.",
  stateHeadline: "La red ya tiene ubicaciones y potencia concretas.",
  stateCopy:
    "Las diez localidades y sus quince cubiertas están identificadas. Actualmente puedes inscribirte en la lista de espera; el calendario y las condiciones se confirmarán por localidad antes de abrir la contratación.",
  updatedAt: "26 de julio de 2026",
  nextAction: "Elegir la localidad y comprobar la cobertura de la dirección",
  modalities: ["Alquiler"],
  power: "1.831 kWp",
  estimatedParticipants: "10 localidades",
  term: "Según contrato",
  radius: "Hasta 5 km*",
  host: "15 instalaciones previstas en 10 localidades de Extremadura",
  overview: [
    "La Comunidad Energética Extremeña agrupa proyectos locales en Mérida, Don Benito, Navalmoral de la Mata, Villafranca de los Barros, Jerez de los Caballeros, Almendralejo, Coria, Cáceres, Plasencia y Zafra.",
    "No se trata de una única instalación regional: cada localidad tiene su propio radio de cobertura y su propio proyecto. Mérida cuenta con cuatro instalaciones previstas; Navalmoral de la Mata y Villafranca de los Barros, con dos cada una.",
    "La modalidad prevista es el alquiler. Las cuotas, la producción estimada y las fechas técnicas se incorporarán a cada localidad cuando estén confirmadas.",
  ],
  commercialStatus: "Lista de espera",
  commercialDataAt: "26 de julio de 2026",
  projectType: "Privada",
  networkStats: {
    municipalities: 10,
    installations: 15,
    panelCount: 2915,
    powerKwp: 1831,
  },
  dataCaveat:
    "Cada localidad tiene su propio radio de cobertura, calendario y condiciones.",
  map: { x: 28, y: 58 },
  milestones: [
    {
      title: "Diez localidades",
      copy: "La red se despliega en diez municipios de Cáceres y Badajoz.",
      state: "done",
    },
    {
      title: "Quince instalaciones",
      copy: "El proyecto conjunto prevé 2.915 paneles y 1.831 kWp.",
      state: "done",
    },
    {
      title: "Listas de espera",
      copy: "Cada localidad recoge el interés de los suministros con cobertura.",
      state: "current",
    },
    {
      title: "Calendario y condiciones",
      copy: "Se confirmarán individualmente para cada localidad.",
      state: "next",
    },
  ],
  sourceUrl:
    "https://comunidadsolar.es/comunidad-energetica-extremadura/",
};

export const communities: Community[] = [
  ...coreCommunities,
  ...extremaduraCommunities,
];

export const communityPages: Community[] = [
  ...communities,
  extremaduraNetwork,
];

export function getCommunity(slug: string) {
  return communityPages.find((community) => community.slug === slug);
}

export function getNetworkCommunities(networkSlug: string) {
  return communities.filter(
    (community) => community.networkSlug === networkSlug,
  );
}

export function getCommunityDisplayTitle(
  community: Pick<Community, "name">,
) {
  return community.name.toLowerCase().includes("comunidad energética")
    ? community.name
    : `Comunidad Energética de ${community.name}`;
}
