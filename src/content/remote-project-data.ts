export type RemoteProjectStatusTone = "active" | "complete";
export type RemoteProjectAvailabilityTone = "available" | "complete" | "pending";
export type RemoteProjectMilestoneState = "done" | "current";

export type RemoteProjectFact = {
  value: string;
  label: string;
  note?: string;
};

export type RemoteProjectMilestone = {
  title: string;
  copy: string;
  state: RemoteProjectMilestoneState;
};

export type RemoteProjectTechnologyPoint = {
  title: string;
  copy: string;
};

export type RemoteProject = {
  slug: string;
  name: string;
  location: string;
  province: string;
  region: string;
  technology: string;
  image: string;
  imageAlt: string;
  status: string;
  statusTone: RemoteProjectStatusTone;
  availability: string;
  availabilityDetail: string;
  availabilityTone: RemoteProjectAvailabilityTone;
  summary: string;
  stateHeadline: string;
  stateCopy: string;
  reviewedAt: string;
  roleHeadline: string;
  roleCopy: string;
  technologyHeadline: string;
  technologyCopy: string;
  technologyPoints: RemoteProjectTechnologyPoint[];
  facts: RemoteProjectFact[];
  milestones: RemoteProjectMilestone[];
  relatedBlogSlugs: string[];
  sourceUrl: string;
};

export const remoteProjects: RemoteProject[] = [
  {
    slug: "torrontera",
    name: "Torrontera I y II",
    location: "Región de Murcia",
    province: "",
    region: "Región de Murcia",
    technology: "Solar + almacenamiento",
    image: "/media/torrontera.jpg",
    imageAlt:
      "Parque fotovoltaico Torrontera de Comunidad Solar en la Región de Murcia",
    status: "En funcionamiento",
    statusTone: "active",
    availability: "Disponible",
    availabilityDetail:
      "Últimas plazas · el 90 % del proyecto ya está contratado · dato revisado en julio de 2026",
    availabilityTone: "available",
    summary:
      "Produce y almacena energía renovable sin necesitar un tejado propio. Torrontera protege una parte de tu coste energético durante 40 años con dos parques solares en funcionamiento y 4 MWh de almacenamiento.",
    stateHeadline:
      "Dos plantas reales, ya en producción, con paneles y batería todavía disponibles.",
    stateCopy:
      "Torrontera I produce desde agosto de 2023 y Torrontera II desde marzo de 2024. Juntas reúnen unos 2,06 MWp de potencia en paneles y 4 MWh de almacenamiento.",
    reviewedAt: "Julio de 2026",
    roleHeadline:
      "No es una compra para unos meses. Es tranquilidad energética para los próximos 40 años.",
    roleCopy:
      "Haces una inversión hoy para reducir durante décadas tu exposición al precio de la electricidad. El resultado real dependerá de tu consumo, de la producción y de la evolución del mercado.",
    technologyHeadline: "Así llega la energía de Torrontera a tu factura.",
    technologyCopy:
      "Calculamos la compra anticipada de energía que encaja con tu consumo. Tu propuesta y tu contrato identifican una instalación concreta, y Comunidad Solar gestiona cómo se refleja su producción en tu suministro.",
    technologyPoints: [
      {
        title: "Seguimiento solar",
        copy: "Los paneles cambian su orientación de este a oeste para aprovechar más horas de irradiación.",
      },
      {
        title: "Almacenamiento",
        copy: "Los 4 MWh de batería desplazan parte de la energía a otras franjas; no son un sistema de respaldo instalado en casa.",
      },
      {
        title: "Suministro remoto",
        copy: "La comercializadora aplica hora a hora la producción coincidente en el suministro del comunero.",
      },
    ],
    facts: [
      {
        value: "≈2,06 MWp",
        label: "Potencia en módulos",
      },
      {
        value: "3.808",
        label: "Paneles de 540 W",
      },
      {
        value: "4 MWh",
        label: "Almacenamiento",
      },
      { value: "2", label: "Plantas en producción" },
    ],
    milestones: [
      {
        title: "Torrontera I",
        copy: "La primera planta produce desde agosto de 2023.",
        state: "done",
      },
      {
        title: "Torrontera II",
        copy: "La segunda planta produce desde marzo de 2024.",
        state: "done",
      },
      {
        title: "Incorporación a Comunidad Solar",
        copy: "Las dos plantas pasan a formar parte de Comunidad Solar en 2025.",
        state: "done",
      },
      {
        title: "Solar + batería",
        copy: "El proyecto incorpora 4 MWh de almacenamiento a su propuesta de Autoconsumo Remoto.",
        state: "current",
      },
    ],
    relatedBlogSlugs: ["torrontera-ya-esta-en-marcha"],
    sourceUrl: "https://comunidadsolar.es/proyecto-torrontera/",
  },
  {
    slug: "fuente-alamo",
    name: "Fuente Álamo I y II",
    location: "Fuente Álamo",
    province: "Murcia",
    region: "Región de Murcia",
    technology: "Solar fotovoltaica",
    image: "/media/fuente-alamo.jpeg",
    imageAlt:
      "Parque solar de Autoconsumo Remoto Fuente Álamo de Comunidad Solar",
    status: "En funcionamiento",
    statusTone: "active",
    availability: "Completo",
    availabilityDetail: "Sin plazas disponibles para nuevas incorporaciones",
    availabilityTone: "complete",
    summary:
      "Fuente Álamo I y II forman un conjunto de dos parques solares en funcionamiento que dieron origen a la primera generación del Autoconsumo Remoto.",
    stateHeadline:
      "Fuente Álamo sigue produciendo para sus comuneros y ya está completo.",
    stateCopy:
      "Los dos parques están finalizados y en funcionamiento. Sus participaciones están completas, por lo que esta ficha sirve para conocer el activo y para que los comuneros accedan a su información privada.",
    reviewedAt: "Julio de 2026",
    roleHeadline:
      "Aquí comenzó la primera generación solar del Autoconsumo Remoto.",
    roleCopy:
      "Fuente Álamo permitió que miles de personas sin tejado propio participaran en producción fotovoltaica a distancia. Su energía solar se complementó con la central hidroeléctrica de Ligüérzana para construir el primer mix renovable de Comunidad Solar.",
    technologyHeadline: "Dos parques solares con seguimiento a un eje.",
    technologyCopy:
      "Las instalaciones reúnen 1.903 paneles de 540 W —unos 1,03 MWp en módulos— y seguidores que acompañan el recorrido del sol.",
    technologyPoints: [
      {
        title: "La Cervantina",
        copy: "Fue la primera etapa del proyecto y abrió el camino del Autoconsumo Remoto solar en Murcia.",
      },
      {
        title: "Segunda instalación",
        copy: "La segunda instalación amplió la capacidad del conjunto de Fuente Álamo.",
      },
      {
        title: "Solar + hidráulica",
        copy: "La producción solar se combinó con Ligüérzana para repartir mejor la generación a lo largo del tiempo.",
      },
    ],
    facts: [
      { value: "≈1,03 MWp", label: "Potencia en módulos" },
      { value: "1.903", label: "Paneles de 540 W" },
      { value: "1 eje", label: "Seguimiento solar" },
      { value: "2", label: "Parques en Murcia" },
    ],
    milestones: [
      {
        title: "Primer parque solar",
        copy: "La Cervantina abre la primera etapa fotovoltaica del modelo remoto.",
        state: "done",
      },
      {
        title: "Ampliación del proyecto",
        copy: "La segunda instalación aumenta la capacidad solar del conjunto en Fuente Álamo.",
        state: "done",
      },
      {
        title: "Proyecto completo",
        copy: "Las plazas publicadas para Fuente Álamo I y II figuran como completas.",
        state: "done",
      },
      {
        title: "Operación y seguimiento",
        copy: "El proyecto continúa produciendo para los comuneros vinculados.",
        state: "current",
      },
    ],
    relatedBlogSlugs: [
      "fuente-alamo-vuelve-a-abrir-sus-puertas",
      "septimo-aniversario-capsula-del-tiempo",
      "bautizo-bajo-la-lluvia-en-fuente-alamo",
    ],
    sourceUrl: "https://comunidadsolar.es/megapark-fuente-alamo/",
  },
  {
    slug: "liguerzana",
    name: "Ligüérzana · Central del Pisuerga",
    location: "Ligüérzana",
    province: "Palencia",
    region: "Castilla y León",
    technology: "Hidroeléctrica",
    image: "/media/liguerzana.jpg",
    imageAlt:
      "Central hidroeléctrica de Ligüérzana de Comunidad Solar en el río Pisuerga",
    status: "En funcionamiento",
    statusTone: "active",
    availability: "Completo",
    availabilityDetail: "Sin plazas disponibles para nuevas incorporaciones",
    availabilityTone: "complete",
    summary:
      "Una central hidroeléctrica de 500 kW en el río Pisuerga que convirtió la fuerza del agua en energía para los primeros comuneros y complementó la producción solar fuera de las horas de sol.",
    stateHeadline:
      "La central sigue produciendo para sus comuneros.",
    stateCopy:
      "Ligüérzana aprovecha el caudal del río Pisuerga para producir energía renovable. Como toda central hidráulica, su generación varía con el agua disponible, la estación y los periodos de mantenimiento.",
    reviewedAt: "Julio de 2026",
    roleHeadline:
      "El agua amplía las horas en las que los comuneros cuentan con producción renovable.",
    roleCopy:
      "Ligüérzana se combinó con los parques solares de Fuente Álamo para construir un mix más equilibrado: sol cuando hay irradiación y producción hidráulica con una curva diferente.",
    technologyHeadline: "Así convierte el Pisuerga su fuerza en energía.",
    technologyCopy:
      "La fuerza del agua mueve la turbina de una central de 500 kW. Su producción se reparte entre participaciones contractuales equivalentes de 75 W y 100 W.",
    technologyPoints: [
      {
        title: "Generación hidráulica",
        copy: "La central transforma el caudal del Pisuerga en electricidad renovable.",
      },
      {
        title: "Producción variable",
        copy: "El caudal, la estacionalidad y el mantenimiento influyen en la energía generada en cada periodo.",
      },
      {
        title: "Complemento del sol",
        copy: "Su perfil hidráulico complementa los parques fotovoltaicos de Fuente Álamo.",
      },
    ],
    facts: [
      { value: "500 kW", label: "Potencia de la central" },
      { value: "75 / 100 W", label: "Participaciones equivalentes" },
      { value: "Pisuerga", label: "Río" },
      { value: "Palencia", label: "Provincia" },
    ],
    milestones: [
      {
        title: "Central incorporada",
        copy: "La central del Pisuerga se incorpora al primer mix de Autoconsumo Remoto.",
        state: "done",
      },
      {
        title: "Producción distribuida",
        copy: "Su producción se reparte entre comuneros mediante participaciones contractuales.",
        state: "done",
      },
      {
        title: "Mix solar e hidráulico",
        copy: "Su generación complementa los parques solares de Fuente Álamo.",
        state: "done",
      },
      {
        title: "Operación y seguimiento",
        copy: "La central sigue produciendo y cada comunero consulta sus datos en la app.",
        state: "current",
      },
    ],
    relatedBlogSlugs: ["encuentro-comunero-en-liguerzana"],
    sourceUrl: "https://comunidadsolar.es/megapark-pisuerga/",
  },
];

export function getRemoteProject(slug: string) {
  return remoteProjects.find((project) => project.slug === slug);
}
