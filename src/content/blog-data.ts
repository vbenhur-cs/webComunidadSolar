export type BlogCategory =
  | "Comunidad"
  | "Eventos"
  | "Historias"
  | "Proyectos"
  | "Actualidad";

export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string;
  date: string;
  displayDate: string;
  category: BlogCategory;
  format: "Crónica" | "Archivo de evento" | "Historia" | "Diario de proyecto";
  location?: string;
  image: string;
  imageAlt: string;
  sourceUrl: string;
  sourceLabel: string;
  archive?: boolean;
  featured?: boolean;
  body: string[];
  highlights?: string[];
  media?: {
    label: string;
    url: string;
  };
};

export const blogPosts: BlogPost[] = [
  {
    slug: "ceuti-termina-su-instalacion",
    title: "Ceutí termina su instalación y entra en la fase de legalización",
    excerpt:
      "La cubierta del Complejo Deportivo Antonio Peñalver ya está preparada. El siguiente paso es completar la inspección y conectar la producción con los suministros de los vecinos.",
    date: "2026-01-12",
    displayDate: "12 enero 2026",
    category: "Proyectos",
    format: "Diario de proyecto",
    location: "Ceutí · Murcia",
    image: "/media/ceuti.jpg",
    imageAlt:
      "Cubierta de la Comunidad Energética de Ceutí junto al núcleo urbano",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/comunidad-energ%C3%A9tica-de-ceut%C3%AD-avances-y-novedades",
    sourceLabel: "Diario público de Ceutí",
    featured: true,
    body: [
      "La instalación fotovoltaica de la Comunidad Energética de Ceutí ha quedado finalizada sobre el Complejo Deportivo Antonio Peñalver. La documentación técnica se ha enviado para la inspección correspondiente, paso previo a completar la legalización.",
      "Este diario de proyecto permite seguir el recorrido que no siempre se ve: desde la presentación a los vecinos y las primeras reservas hasta la obra, la inspección y la futura activación de la energía en las facturas.",
    ],
    highlights: [
      "Instalación fotovoltaica finalizada",
      "Documentación remitida para inspección",
      "Proyecto impulsado junto al Ayuntamiento de Ceutí",
    ],
  },
  {
    slug: "villalbilla-dos-colegios-una-comunidad",
    title: "Dos colegios y una comunidad que ya toma forma en Villalbilla",
    excerpt:
      "El proyecto del CEIP Gregorio Canella está legalizado y la segunda instalación, en el CEIP Salvador Dalí, inicia su fase de obra.",
    date: "2025-12-23",
    displayDate: "23 diciembre 2025",
    category: "Proyectos",
    format: "Diario de proyecto",
    location: "Villalbilla · Madrid",
    image: "/media/villalbilla.jpg",
    imageAlt:
      "Vista del entorno de la Comunidad Energética de Villalbilla",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/villalbilla-da-un-paso-hacia-la-sostenibilidad-%C3%A9xito-en-el-evento-de-presentaci%C3%B3n-de-su-comunidad-energ%C3%A9tica",
    sourceLabel: "Diario público de Villalbilla",
    body: [
      "A 23 de diciembre de 2025, la primera instalación de Villalbilla, situada en el CEIP Gregorio Canella, había completado su legalización y preparaba su puesta en servicio. El proyecto del CEIP Salvador Dalí entraba en obra para ampliar la energía compartida disponible en el municipio.",
      "La comunidad comenzó con una reunión abierta en el ayuntamiento y continúa avanzando hito a hito. Publicar cada paso ayuda a entender que una comunidad energética no aparece de un día para otro: se construye con vecinos, cubiertas públicas, ingeniería y seguimiento.",
    ],
    highlights: [
      "Primera cubierta legalizada",
      "Segunda instalación en marcha",
      "Seguimiento público de los hitos",
    ],
  },
  {
    slug: "ceuti-encuentro-con-los-vecinos",
    title: "Ceutí se sienta a hablar de su energía",
    excerpt:
      "Vecinos, ayuntamiento y equipo de Comunidad Solar se reunieron para resolver dudas y conocer cómo participar en el proyecto local.",
    date: "2025-12-12",
    displayDate: "12 diciembre 2025",
    category: "Comunidad",
    format: "Crónica",
    location: "Ceutí · Murcia",
    image: "/media/blog-ceuti-detalle.jpg",
    imageAlt:
      "Presentación de la Comunidad Energética de Ceutí con vecinos y representantes municipales",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/comunidad-energ%C3%A9tica-de-ceut%C3%AD-avances-y-novedades",
    sourceLabel: "Crónica e imágenes de Ceutí",
    featured: true,
    body: [
      "La Comunidad Energética de Ceutí se presentó oficialmente en un encuentro abierto con vecinos y empresas del municipio. La alcaldesa Sonia Almela acompañó una sesión dedicada a explicar el proyecto y responder preguntas sin atajos.",
      "Varias personas reservaron su participación durante la propia jornada. Más allá de los paneles, estos encuentros son el momento en el que una instalación empieza a convertirse de verdad en una comunidad.",
    ],
    highlights: [
      "Encuentro abierto a vecinos y empresas",
      "Preguntas respondidas por el equipo",
      "Primeras reservas durante la jornada",
    ],
    media: {
      label: "Ver la publicación en LinkedIn",
      url: "https://es.linkedin.com/posts/comunidadsolar_ceut%C3%AD-murcia-comunidadenerg%C3%A9tica-activity-7406264855998996480-ktWT",
    },
  },
  {
    slug: "fuente-alamo-vuelve-a-abrir-sus-puertas",
    title: "Fuente Álamo vuelve a abrir sus puertas a los comuneros",
    excerpt:
      "Una jornada para recorrer el parque, conocer cómo trabaja y volver a poner cara a las personas que comparten su energía.",
    date: "2025-11-15",
    displayDate: "15 noviembre 2025",
    category: "Eventos",
    format: "Archivo de evento",
    location: "Región de Murcia",
    image: "/media/evento-visita-parque.jpg",
    imageAlt:
      "Cartel original de la visita al parque de Fuente Álamo en 2025",
    sourceUrl:
      "https://eventos.comunidadsolar.es/VisitaParqueAutoconsumoRemoto15denoviembre",
    sourceLabel: "Programa original del encuentro",
    body: [
      "El parque de autoconsumo remoto de Fuente Álamo volvió a convocar a los comuneros para una visita técnica. El recorrido estaba pensado para ver de cerca los paneles, inversores y seguidores, y entender cómo se transforma el sol de Murcia en producción asignada a hogares de toda España.",
      "La jornada se completó con una comida informal y un webinar desde el propio parque. La intención era tan importante como el contenido técnico: encontrarse con el equipo y con otras personas que comparten el mismo proyecto.",
    ],
    highlights: [
      "Recorrido técnico por la instalación",
      "Encuentro entre comuneros y equipo",
      "Comida y webinar desde el parque",
    ],
  },
  {
    slug: "comuneros-por-el-mundo-jose-luis",
    title: "José Luis abre la puerta a «Comuneros por el Mundo»",
    excerpt:
      "Desde Castilla y León, enseña cómo recibe en casa la energía de seis módulos situados a más de 550 kilómetros.",
    date: "2025-10-31",
    displayDate: "31 octubre 2025",
    category: "Historias",
    format: "Historia",
    location: "Castilla y León",
    image: "/media/radio-cyl.jpg",
    imageAlt:
      "José Luis Martín explica su experiencia como comunero en Castilla y León Televisión",
    sourceUrl:
      "https://es.linkedin.com/posts/comunidadsolar_ayer-salimos-en-radio-televisi%C3%B3n-de-castilla-activity-7389998343499694081-v5hG",
    sourceLabel: "Publicación original de Comunidad Solar",
    body: [
      "José Luis Martín abrió su casa a Castilla y León Televisión para explicar una solución difícil de imaginar hasta que alguien la cuenta desde su propia factura: tiene asignados seis módulos solares en Fuente Álamo, a más de 550 kilómetros.",
      "Su historia inauguró una línea que merece crecer dentro del Blog: «Comuneros por el Mundo». Visitas breves para conocer a las personas, sus decisiones y la forma concreta en la que la energía compartida entra en su vida cotidiana.",
    ],
    highlights: [
      "Testimonio grabado en casa de un comunero",
      "Seis módulos en Fuente Álamo",
      "Primer capítulo de una serie para continuar",
    ],
    media: {
      label: "Ver el reportaje en vídeo",
      url: "https://vimeo.com/1132434330",
    },
  },
  {
    slug: "septimo-aniversario-capsula-del-tiempo",
    title: "Siete años de comunidad y una cápsula para el futuro",
    excerpt:
      "El Solsticio de 2025 celebró lo construido y guardó mensajes para las generaciones que recibirán la energía que hoy estamos poniendo en marcha.",
    date: "2025-06-21",
    displayDate: "21 junio 2025",
    category: "Eventos",
    format: "Archivo de evento",
    location: "Villalbilla · Fuente Álamo · Las Rozas",
    image: "/media/evento-solsticio-2025.jpg",
    imageAlt:
      "Cartel original del séptimo aniversario y Solsticio de Comunidad Solar en 2025",
    sourceUrl:
      "https://eventos.comunidadsolar.es/JornadaSolsticioVerano2025",
    sourceLabel: "Programa original del Solsticio 2025",
    body: [
      "El séptimo aniversario quiso unir tres lugares y una misma comunidad: Villalbilla, el parque de Fuente Álamo y la sede de Las Rozas. Después del apagón de abril, el encuentro puso sobre la mesa una idea sencilla: compartir energía también es construir resiliencia.",
      "Una cápsula del tiempo recogió mensajes de comuneros para hijos, nietos y generaciones futuras. El gesto convirtió una celebración en una promesa: recordar dentro de décadas por qué empezamos a producir energía de otra manera.",
    ],
    highlights: [
      "Celebración en tres emplazamientos",
      "Mensajes para una cápsula del tiempo",
      "Encuentro de socios, equipo y comuneros",
    ],
  },
  {
    slug: "torrontera-ya-esta-en-marcha",
    title: "Torrontera se incorpora a Comunidad Solar",
    excerpt:
      "Las plantas, que ya estaban en producción, pasan a formar parte de Comunidad Solar en 2025.",
    date: "2025-06-19",
    displayDate: "19 junio 2025",
    category: "Actualidad",
    format: "Diario de proyecto",
    location: "Fuente Álamo · Murcia",
    image: "/media/las-vegas-mazarron.jpg",
    imageAlt: "Parque fotovoltaico de Torrontera en funcionamiento",
    sourceUrl: "https://www.instagram.com/reel/DLFRMtyKKUm/",
    sourceLabel: "Publicación original en Instagram",
    body: [
      "La publicación de junio de 2025 documenta la incorporación de Torrontera a Comunidad Solar, no el inicio de su producción. Torrontera I ya producía desde 2023 y Torrontera II desde 2024.",
      "Desde 2025, ambas plantas forman parte de Comunidad Solar. Distinguir la fecha de producción de la fecha de incorporación permite contar con precisión la evolución de los activos que sostienen el servicio.",
    ],
    highlights: [
      "Producción iniciada antes de 2025",
      "Incorporación a Comunidad Solar en 2025",
      "Dos plantas en funcionamiento",
    ],
  },
  {
    slug: "puebla-del-principe-entra-en-construccion",
    title: "Puebla del Príncipe entra en construcción",
    excerpt:
      "Tras la visita al emplazamiento y el trabajo previo, el proyecto recibe la orden de inicio y avanza con buena parte de su capacidad reservada.",
    date: "2025-04-12",
    displayDate: "12 abril 2025",
    category: "Proyectos",
    format: "Diario de proyecto",
    location: "Puebla del Príncipe · Ciudad Real",
    image: "/media/puebla-del-principe.jpg",
    imageAlt:
      "Terreno de la Comunidad Energética de Puebla del Príncipe",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/actualizaci%C3%B3n-estado-proyecto-puebla",
    sourceLabel: "Diario público de Puebla",
    body: [
      "La comunidad de Puebla del Príncipe recibió la orden de inicio de construcción después de meses de desarrollo, tramitación y trabajo comercial. En ese momento, alrededor del 70 % de su capacidad ya estaba ocupada.",
      "El proyecto se había presentado también sobre el propio terreno para que los futuros participantes pudieran conocer el lugar y preguntar directamente al equipo. El diario conserva ambos momentos: la visita y el paso efectivo a obra.",
    ],
    highlights: [
      "Orden de inicio de construcción",
      "Capacidad mayoritariamente reservada",
      "Visita previa con la comunidad",
    ],
    media: {
      label: "Ver la visita al emplazamiento",
      url: "https://vimeo.com/1047856458",
    },
  },
  {
    slug: "villalbilla-presenta-su-comunidad",
    title: "Villalbilla pregunta, conversa y reserva",
    excerpt:
      "El ayuntamiento abrió sus puertas para presentar el proyecto. La conversación terminó con vecinos dando el primer paso para participar.",
    date: "2025-01-24",
    displayDate: "24 enero 2025",
    category: "Comunidad",
    format: "Crónica",
    location: "Villalbilla · Madrid",
    image: "/media/blog-villalbilla-evento.jpg",
    imageAlt:
      "Presentación pública de la Comunidad Energética de Villalbilla",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/villalbilla-da-un-paso-hacia-la-sostenibilidad-%C3%A9xito-en-el-evento-de-presentaci%C3%B3n-de-su-comunidad-energ%C3%A9tica",
    sourceLabel: "Crónica e imágenes de Villalbilla",
    body: [
      "Vecinos de Villalbilla se reunieron en el ayuntamiento para conocer la comunidad energética proyectada sobre dos colegios públicos. La concejala Vanessa Aguilar acompañó una presentación abierta y una ronda de preguntas.",
      "La conversación no se quedó en una explicación: varios asistentes reservaron paneles durante el encuentro. Fue el comienzo visible de una comunidad que después seguiría avanzando por las fases de obra y legalización.",
    ],
    highlights: [
      "Presentación abierta en el ayuntamiento",
      "Ronda de preguntas con los vecinos",
      "Reservas realizadas en el encuentro",
    ],
  },
  {
    slug: "el-adn-de-comunidad-solar",
    title: "Cuando un vendaval puso a prueba nuestro ADN",
    excerpt:
      "La instalación de Alfonso quedó dañada. La respuesta del equipo y su mensaje posterior explican mejor que cualquier eslogan qué significa acompañar a un comunero.",
    date: "2024-11-12",
    displayDate: "12 noviembre 2024",
    category: "Historias",
    format: "Historia",
    image: "/media/historia-adn-comunidad.jpg",
    imageAlt:
      "Instalación solar doméstica de un comunero de Comunidad Solar",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/esto",
    sourceLabel: "Historia y testimonio original",
    body: [
      "Un vendaval dañó la instalación fotovoltaica de Alfonso. El equipo se organizó para reparar los desperfectos y devolverla a funcionamiento, acompañándolo durante el proceso.",
      "Después llegó un audio suyo por WhatsApp. No hablaba de proveedores y clientes, sino de personas que se sienten parte del mismo proyecto. Esa respuesta espontánea es la razón para recuperar esta historia dentro del archivo.",
    ],
    highlights: [
      "Respuesta del equipo tras el temporal",
      "Instalación reparada",
      "Testimonio directo del comunero",
    ],
  },
  {
    slug: "nuevo-baztan-abre-la-casa-de-un-comunero",
    title: "Una casa abierta para explicar Nuevo Baztán",
    excerpt:
      "Un comunero enseñó su instalación a los vecinos. Verla funcionar y escuchar su experiencia convirtió una explicación técnica en algo cercano y comprobable.",
    date: "2024-10-19",
    displayDate: "19 octubre 2024",
    category: "Comunidad",
    format: "Crónica",
    location: "Nuevo Baztán · Madrid",
    image: "/media/blog-nuevo-baztan-detalle.jpg",
    imageAlt:
      "Jornada de puertas abiertas en la casa de un comunero de Nuevo Baztán",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/comunidad-energ%C3%A9tica-de-nuevo-bazt%C3%A1n-avances-y-novedades",
    sourceLabel: "Diario público de Nuevo Baztán",
    featured: true,
    body: [
      "Un vecino de Nuevo Baztán abrió su casa para que otras personas pudieran ver una instalación funcionando, preguntar sin prisas y conocer la experiencia de alguien que ya había dado el paso.",
      "Ese formato sencillo —una casa real, un comunero y sus vecinos— hizo tangible el proyecto. En aquel momento, la primera fase de la comunidad ya estaba completa con 29 familias.",
    ],
    highlights: [
      "Instalación real abierta a los vecinos",
      "Experiencia explicada por un comunero",
      "Primera fase con 29 familias",
    ],
  },
  {
    slug: "solsticio-2024-sexto-aniversario",
    title: "Un Solsticio para aprender, probar y celebrar",
    excerpt:
      "Comunidades energéticas, talleres, vehículos eléctricos, tecnología, música y familias compartieron el sexto aniversario.",
    date: "2024-06-21",
    displayDate: "21 junio 2024",
    category: "Eventos",
    format: "Archivo de evento",
    location: "Las Rozas · Madrid",
    image: "/media/evento-solsticio-2024.jpg",
    imageAlt:
      "Cartel original del Solsticio 2024 y sexto aniversario de Comunidad Solar",
    sourceUrl:
      "https://eventos.comunidadsolar.es/21deJuniofiestadelSolsticioVerano2024",
    sourceLabel: "Programa original del Solsticio 2024",
    body: [
      "El sexto aniversario convirtió la sede de Las Rozas en un espacio abierto para hablar de comunidades energéticas, mejorar instalaciones solares y conocer el plan de independencia energética.",
      "La jornada mezcló contenido y convivencia: exposición tecnológica, pruebas de coches eléctricos, actividades infantiles, música y comida. Una celebración pensada para que el proyecto pudiera vivirse en familia.",
    ],
    highlights: [
      "Seminario sobre comunidades energéticas",
      "Talleres y exposición tecnológica",
      "Actividades para comuneros y familias",
    ],
    media: {
      label: "Ver el webinar para comuneros de 2024",
      url: "https://www.youtube.com/watch?v=s6tJFK9I5S8",
    },
  },
  {
    slug: "premio-comunidad-goparity",
    title: "Un premio que reconoce la fuerza de la comunidad",
    excerpt:
      "GoParity distinguió en Oporto una campaña que logró la mayor participación externa de la historia de su plataforma.",
    date: "2024-05-16",
    displayDate: "16 mayo 2024",
    category: "Actualidad",
    format: "Crónica",
    location: "Oporto · Portugal",
    image: "/media/premio-goparity.jpg",
    imageAlt:
      "Comuneros de Comunidad Solar reunidos en torno a uno de sus proyectos",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/celebramos-un-nuevo-logro-premio-a-la-innovaci%C3%B3n-en-energ%C3%ADa-solar-en-oporto",
    sourceLabel: "Crónica original del premio",
    body: [
      "GoParity entregó a Comunidad Solar el Premio Comunidad por la participación conseguida en una de sus campañas de financiación. La convocatoria movilizó a más personas externas a la plataforma que ninguna campaña anterior.",
      "Paco recogió el reconocimiento en Oporto y lo compartió con el equipo y con quienes habían decidido respaldar el proyecto. El premio pertenece a esa suma de pequeñas decisiones.",
    ],
    highlights: [
      "Premio Comunidad de GoParity",
      "Participación externa récord en la plataforma",
      "Reconocimiento compartido con equipo y comuneros",
    ],
  },
  {
    slug: "encuentro-comunero-en-liguerzana",
    title: "Sesenta y cinco personas, una central y 750 ovejas",
    excerpt:
      "El encuentro de Ligüérzana mezcló una visita técnica, conversación, comida y uno de esos momentos que no caben en una presentación corporativa.",
    date: "2024-04-20",
    displayDate: "20 abril 2024",
    category: "Comunidad",
    format: "Crónica",
    location: "Ligüérzana · Palencia",
    image: "/media/historia-comunero-8.png",
    imageAlt:
      "Comuneros visitando la central hidroeléctrica del Pisuerga en Ligüérzana",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/encuentro-comunero-en-la-central-hidroel%C3%A9ctrica-de-comunidad-solar",
    sourceLabel: "Crónica original del encuentro",
    featured: true,
    body: [
      "Alrededor de 65 personas visitaron la central hidroeléctrica del Pisuerga. Antonio Manuel y Eugenio guiaron el recorrido técnico antes de continuar la conversación alrededor de una comida y un encuentro con Paco y el equipo.",
      "Durante la visita, un pastor atravesó el lugar con unas 750 ovejas. La escena quedó como una imagen perfecta de la jornada: energía, territorio, comunidad y naturaleza compartiendo el mismo espacio.",
    ],
    highlights: [
      "Unas 65 personas participaron",
      "Visita técnica y conversación abierta",
      "Vídeo resumen disponible",
    ],
    media: {
      label: "Ver el vídeo del encuentro",
      url: "https://www.youtube.com/watch?v=ahXDNlm3YHs",
    },
  },
  {
    slug: "nace-la-comunidad-de-nuevo-baztan",
    title: "Nuevo Baztán empieza alrededor de una conversación",
    excerpt:
      "Ayuntamiento, vecinos y equipo presentaron una comunidad energética que después crecería sobre dos cubiertas del municipio.",
    date: "2024-04-19",
    displayDate: "19 abril 2024",
    category: "Proyectos",
    format: "Crónica",
    location: "Nuevo Baztán · Madrid",
    image: "/media/nuevo-baztan.jpeg",
    imageAlt:
      "Vista aérea de una de las cubiertas de la Comunidad Energética de Nuevo Baztán",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/kb/articles/lanzamiento-de-la-comunidad-energ%C3%A9tica-de-nuevo-bazt%C3%A1n",
    sourceLabel: "Crónica original del lanzamiento",
    body: [
      "La Oficina de Turismo de Nuevo Baztán acogió la presentación pública de la comunidad energética. Representantes municipales, vecinos y el equipo de Comunidad Solar compartieron el modelo y resolvieron las primeras dudas.",
      "Aquella reunión abrió un recorrido que después llenaría su primera fase y llevaría paneles a la Nave Municipal y al CEIPSO Juan de Goyeneche.",
    ],
    highlights: [
      "Presentación pública con el municipio",
      "Participación abierta de los vecinos",
      "Inicio de un proyecto sobre dos cubiertas",
    ],
    media: {
      label: "Ver el vídeo de la presentación",
      url: "https://vimeo.com/937702869",
    },
  },
  {
    slug: "solsticio-2023-quinto-aniversario",
    title: "El quinto aniversario volvió a reunir a la comunidad",
    excerpt:
      "Tecnología solar, actividades para niños, música y conversación compartieron espacio en la fiesta del Solsticio.",
    date: "2023-06-21",
    displayDate: "21 junio 2023",
    category: "Eventos",
    format: "Archivo de evento",
    location: "Las Rozas · Madrid",
    image: "/media/evento-solsticio-2023.jpg",
    imageAlt:
      "Cartel original de la fiesta del Solsticio y quinto aniversario en 2023",
    sourceUrl:
      "https://eventos.comunidadsolar.es/JornadaPuertasAbiertasSolsticioVerano2023",
    sourceLabel: "Programa original del Solsticio 2023",
    archive: true,
    body: [
      "El Solsticio de 2023 celebró el quinto aniversario con una tarde abierta a comuneros y familias. SumSol, Bet Solar y Green Solutions acercaron novedades del sector a la comunidad.",
      "Animación infantil, música, comida y regalos completaron un encuentro pensado para que la tecnología no eclipsara lo principal: volver a verse y compartir el camino recorrido.",
    ],
    highlights: [
      "Quinto aniversario",
      "Novedades de tecnología solar",
      "Encuentro abierto a comuneros y familias",
    ],
  },
  {
    slug: "bautizo-bajo-la-lluvia-en-fuente-alamo",
    title: "Cruzar España para bautizar unos paneles bajo la lluvia",
    excerpt:
      "Decenas de comuneros viajaron a Murcia para poner nombre a sus paneles. El diluvio no impidió una de las escenas fundacionales del autoconsumo remoto.",
    date: "2023-06-03",
    displayDate: "3 junio 2023",
    category: "Historias",
    format: "Crónica",
    location: "Fuente Álamo · Murcia",
    image: "/media/historia-youtube-reqBqJBFQIk.jpg",
    imageAlt:
      "Comuneros durante la inauguración del parque de Fuente Álamo",
    sourceUrl:
      "https://elpais.com/sociedad/2023-07-14/cruzar-espana-para-bautizar-unos-paneles-solares.html",
    sourceLabel: "Reportaje de El País",
    archive: true,
    body: [
      "Unas cincuenta personas viajaron hasta Fuente Álamo para conocer el parque desde el que recibirían su energía. Llegaron desde distintos puntos de España, buscaron sus paneles y colocaron en ellos nombres con significado personal.",
      "La lluvia convirtió la inauguración en un pequeño diluvio, pero nadie se fue. Entre los asistentes estaba Josefa González Alcalde, de 89 años, que había viajado con su familia desde Manresa. Aquella jornada puso rostro al modelo de autoconsumo remoto.",
    ],
    highlights: [
      "Comuneros llegados desde distintos puntos de España",
      "Paneles bautizados con nombres personales",
      "Una inauguración recordada bajo la lluvia",
    ],
    media: {
      label: "Ver el vídeo de Fuente Álamo",
      url: "https://www.youtube.com/watch?v=reqBqJBFQIk",
    },
  },
  {
    slug: "solsticio-2022-puertas-abiertas",
    title: "El Solsticio de 2022 abrió las puertas de casa",
    excerpt:
      "Formación, tecnología, música y actividades familiares ocuparon una jornada completa con capacidad para quinientas personas.",
    date: "2022-06-21",
    displayDate: "21 junio 2022",
    category: "Eventos",
    format: "Archivo de evento",
    location: "Las Rozas · Madrid",
    image: "/media/evento-solsticio-2022.jpg",
    imageAlt:
      "Cartel original de la jornada de puertas abiertas del Solsticio de 2022",
    sourceUrl: "https://eventos.comunidadsolar.es/SolsticioVerano2022",
    sourceLabel: "Programa original del Solsticio 2022",
    archive: true,
    body: [
      "La jornada de puertas abiertas de 2022 ocupó todo el día en la sede de Las Rozas. Hubo formación sobre comunidades energéticas, exposición de tecnología solar y un concurso para diseñar la camiseta de la comunidad.",
      "Las actividades infantiles, los food trucks y la música convirtieron un programa energético en una reunión para todas las edades. El archivo conserva el primer gran formato del Solsticio.",
    ],
    highlights: [
      "Jornada de 10:00 a 22:00",
      "Formación y exposición solar",
      "Programa familiar con aforo para 500 personas",
    ],
  },
  {
    slug: "manolo-un-ano-viviendo-con-el-sol",
    title: "Manolo: un año viviendo con el sol",
    excerpt:
      "Una cubierta de pizarra, un primer año de producción y una familia que aprendió a desplazar sus consumos a las horas solares.",
    date: "2021-04-17",
    displayDate: "17 abril 2021",
    category: "Historias",
    format: "Historia",
    image: "/media/experiencia-comunero.jpg",
    imageAlt: "Manolo junto a su instalación solar sobre cubierta de pizarra",
    sourceUrl:
      "https://ayuda.comunidadsolar.es/portal/en-gb/community/topic/experiencias-mas-de-1-a%C3%B1o-con-instalaci%C3%B3n-solar",
    sourceLabel: "Testimonio original del comunero",
    archive: true,
    body: [
      "Manolo de la Rica compartió cómo había vivido el primer año con paneles sobre una cubierta de pizarra. La instalación superó lluvias y granizo sin dañar el tejado, una preocupación importante antes de empezar.",
      "En casa aprendieron a mover parte del consumo a las horas de producción. Pero su motivación no era únicamente económica: hablaba de independencia y del futuro que quería dejar a hijos y nietos.",
    ],
    highlights: [
      "Testimonio directo tras un año de uso",
      "Instalación sobre cubierta de pizarra",
      "Nuevos hábitos de consumo en familia",
    ],
  },
];

export const blogCategories: Array<"Todos" | BlogCategory> = [
  "Todos",
  "Comunidad",
  "Eventos",
  "Historias",
  "Proyectos",
  "Actualidad",
];

export function getBlogPost(slug: string) {
  return blogPosts.find((post) => post.slug === slug);
}
