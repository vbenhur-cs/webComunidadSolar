export type EventPlatform = {
  name: "Zoho Backstage" | "Zoho TrainerCentral";
  href: string;
  action: string;
};

export type PublicEvent = {
  slug: string;
  title: string;
  summary: string;
  date: string;
  displayDate: string;
  location: string;
  format: "Encuentro" | "Webinar" | "Evento híbrido";
  platforms: EventPlatform[];
  image?: string;
  imageAlt?: string;
  tone?: "green" | "yellow" | "blue";
};

export const eventsLastReviewed = "28 julio 2026";

/*
 * La agenda pública es deliberadamente curada: solo contiene convocatorias
 * publicadas que se celebraron o que tienen una inscripción pública abierta.
 * Los webinars privados de socios, las pruebas y los borradores quedan fuera.
 */
export const upcomingEvents: PublicEvent[] = [];

export const pastEvents: PublicEvent[] = [
  {
    slug: "visita-fuente-alamo-2025",
    title: "Fuente Álamo volvió a abrir sus puertas a los comuneros",
    summary:
      "Una visita para recorrer el parque, entender cómo trabaja y encontrarnos con las personas que comparten su energía.",
    date: "2025-11-15",
    displayDate: "15 noviembre 2025",
    location: "Fuente Álamo · Murcia",
    format: "Encuentro",
    image: "/media/evento-visita-parque.jpg",
    imageAlt:
      "Cartel original de la visita al parque de Fuente Álamo en 2025",
    platforms: [
      {
        name: "Zoho Backstage",
        href: "https://eventos.comunidadsolar.es/VisitaParqueAutoconsumoRemoto15denoviembre",
        action: "Ver el encuentro",
      },
    ],
  },
  {
    slug: "webinar-crowdequity-2025",
    title: "Webinar sobre la campaña de crowdequity",
    summary:
      "Una sesión pública para explicar el plan de negocio y los objetivos de la campaña de inversión. Se conserva como archivo histórico de aquel momento.",
    date: "2025-01-09",
    displayDate: "9 enero 2025 · 18:00",
    location: "Online",
    format: "Webinar",
    tone: "yellow",
    platforms: [
      {
        name: "Zoho TrainerCentral",
        href: "https://comunidadsolar.trainercentralsite.eu/session/webinar-crowdequity-585481681",
        action: "Ver la sesión original",
      },
    ],
  },
  {
    slug: "solsticio-2024",
    title: "Un Solsticio para aprender, probar y celebrar",
    summary:
      "Comunidades energéticas, talleres, vehículos eléctricos, tecnología, música y familias compartieron el sexto aniversario.",
    date: "2024-06-21",
    displayDate: "21 junio 2024 · 12:00",
    location: "Las Rozas · Madrid",
    format: "Encuentro",
    image: "/media/evento-solsticio-2024.jpg",
    imageAlt:
      "Cartel original del Solsticio 2024 y sexto aniversario de Comunidad Solar",
    platforms: [
      {
        name: "Zoho Backstage",
        href: "https://eventos.comunidadsolar.es/21deJuniofiestadelSolsticioVerano2024",
        action: "Ver el programa",
      },
    ],
  },
  {
    slug: "solsticio-2023",
    title: "El quinto aniversario volvió a reunir a la comunidad",
    summary:
      "Tecnología solar, actividades para niños, música y conversación compartieron espacio en la fiesta del Solsticio.",
    date: "2023-06-21",
    displayDate: "21 junio 2023 · 18:00",
    location: "Las Rozas · Madrid",
    format: "Encuentro",
    image: "/media/evento-solsticio-2023.jpg",
    imageAlt:
      "Cartel original de la fiesta del Solsticio y quinto aniversario en 2023",
    platforms: [
      {
        name: "Zoho Backstage",
        href: "https://eventos.comunidadsolar.es/JornadaPuertasAbiertasSolsticioVerano2023",
        action: "Ver el programa",
      },
    ],
  },
];
