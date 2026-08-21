export const partnerUpdate = {
  publishedAt: "30 de julio de 2026",
  isoDate: "2026-07-30",
  edition: "Nueva etapa · julio de 2026",
};

export const financialMetrics = [
  {
    value: "6.265.520 €",
    label: "Facturación agrupada",
    note: "Magnitud de gestión del conjunto de sociedades en 2025.",
  },
  {
    value: "1.162.271 €",
    label: "EBITDA agrupado",
    note: "Resultado operativo antes de amortizaciones y costes financieros.",
  },
  {
    value: "210.624 €",
    label: "Resultado antes de impuestos",
    note: "Magnitud agrupada de gestión correspondiente a 2025.",
  },
  {
    value: "196.394 €",
    label: "Resultado del ejercicio",
    note: "Resultado neto agrupado positivo de 2025.",
  },
] as const;

export const executiveSummary = [
  {
    label: "Lo conseguido",
    title: "2025 confirma que existe un negocio operativo rentable",
    copy: "La actividad agrupada superó 6,2 M€ de facturación y 1,1 M€ de EBITDA. El reto no es demostrar que existe negocio, sino transformar ese margen en caja recurrente.",
    tone: "confirmed",
  },
  {
    label: "Prioridad inmediata",
    title: "Liquidez, balance y disciplina financiera",
    copy: "Estamos reordenando financiación y deuda, activando anticipos de ayudas y reduciendo el coste estructural para que el crecimiento deje de consumir caja propia.",
    tone: "progress",
  },
  {
    label: "Capacidad de crecimiento",
    title: "Construir más sin volver a financiarlo todo nosotros",
    copy: "El acuerdo operativo con Cubierta Solar y FIEE contempla hasta 8 M€ de capacidad para proyectos elegibles mediante PPAs de largo plazo.",
    tone: "confirmed",
  },
  {
    label: "Próximos 90 días",
    title: "Chiva, almacenamiento, Helios y relanzamiento comercial",
    copy: "La incorporación de activos, las ayudas de almacenamiento, el despliegue de Helios y el nuevo liderazgo financiero y comercial concentran la ejecución inmediata.",
    tone: "progress",
  },
] as const;

export const milestoneAgenda = [
  {
    date: "31 JUL",
    isoDate: "2026-07-31",
    year: "2026",
    kind: "Fecha confirmada",
    title: "Notaría para la compra del proyecto Chiva",
    copy: "La cita notarial está confirmada. Si la firma se completa conforme a lo previsto, la compraventa incorporará un activo clave y permitirá continuar la ejecución del plan asociado a Chiva.",
    impact:
      "Por qué importa: permitiría sumar patrimonio energético y mantener abierta una ayuda potencial de 1,8 M€ vinculada al proyecto.",
    tone: "confirmed",
  },
  {
    date: "20 AGO",
    isoDate: "2026-08-20",
    year: "2026",
    kind: "Fecha confirmada",
    title: "Comité de Dirección",
    copy: "Revisión ejecutiva del avance financiero, comercial, tecnológico y de proyectos tras las primeras semanas de esta nueva etapa.",
    impact:
      "Es una reunión de dirección, no un Consejo de Administración ni una Junta General.",
    tone: "confirmed",
  },
  {
    date: "SEP",
    isoDate: "2026-09",
    year: "2026",
    kind: "Ventana objetivo",
    title: "Anticipos de ayudas de El Pedernoso",
    copy: "El roadmap sitúa en septiembre la tramitación de los anticipos de los dos proyectos que suman aproximadamente 536.000 € en ayudas concedidas.",
    impact:
      "La fecha exacta depende de la tramitación y aprobación administrativa.",
    tone: "scenario",
  },
] as const;

export const roadmapPhases = [
  {
    period: "Ahora · julio—septiembre 2026",
    title: "Estabilizar y preparar",
    status: "En ejecución",
    tone: "progress",
    items: [
      "Formalizar la adquisición de Chiva y avanzar su estructura financiera.",
      "Ordenar tesorería, reporting, deuda y anticipos de subvenciones.",
      "Integrar el nuevo liderazgo financiero y comercial.",
      "Completar los flujos prioritarios de Helios.",
    ],
  },
  {
    period: "Siguiente · cuarto trimestre 2026",
    title: "Incorporar activos y acelerar",
    status: "Planificado",
    tone: "scenario",
    items: [
      "Ejecutar los proyectos de almacenamiento de Extremadura.",
      "Activar el crecimiento de comunidades mediante PPAs.",
      "Relanzar Autoconsumo Remoto, Comunidades Energéticas y fotovoltaica.",
      "Preparar procesos, datos y documentación para una futura due diligence.",
    ],
  },
  {
    period: "Escala · próximos doce meses",
    title: "Crecer con una estructura más ligera",
    status: "Objetivo",
    tone: "scenario",
    items: [
      "Desarrollar hasta 20 MW de comunidades de proximidad.",
      "Extender Helios a la gestión integral de clientes y activos.",
      "Abrir la gestión de comunidades y activos de terceros.",
      "Preparar la siguiente etapa corporativa y de gobierno.",
    ],
  },
] as const;

export const allianceFacts = [
  {
    value: "Sin dilución",
    title: "La integración societaria no se ejecutó",
    copy: "No hubo ampliación de capital, no cambió el Consejo y los socios actuales no sufrieron dilución.",
  },
  {
    value: "Hasta 8 M€",
    title: "Capacidad para proyectos elegibles",
    copy: "Cubierta Solar, con el respaldo de FIEE, puede financiar y construir proyectos mediante PPAs a largo plazo.",
  },
  {
    value: "20 MW",
    title: "Objetivo a doce meses",
    copy: "Es un objetivo de ejecución de comunidades energéticas, no una previsión garantizada ni dinero disponible en tesorería.",
  },
] as const;

export const grantedSubsidies = [
  {
    project: "Puebla del Príncipe",
    amount: "495.000 €",
  },
  {
    project: "El Pedernoso · Cintia",
    amount: "≈ 250.000 €",
  },
  {
    project: "El Pedernoso · Damián",
    amount: "≈ 286.000 €",
  },
  {
    project: "Extremadura · Bloque 1",
    amount: "524.944 €",
  },
  {
    project: "Extremadura · Bloque 2",
    amount: "366.320 €",
  },
] as const;

export const potentialSubsidies = [
  {
    project: "Chiva",
    amount: "1.800.000 €",
  },
  {
    project: "Manganáfer",
    amount: "2.450.000 €",
  },
  {
    project: "Piedrabuena",
    amount: "1.800.000 €",
  },
] as const;

export const growthEngines = [
  {
    marker: "01",
    title: "Autoconsumo Remoto",
    copy: "Recuperar el producto nacional incorporando almacenamiento y una propuesta energética más estable.",
  },
  {
    marker: "02",
    title: "Comunidades Energéticas",
    copy: "Escalar compra y alquiler por panel con construcción financiada por terceros y una cartera creciente de cubiertas.",
  },
  {
    marker: "03",
    title: "Instalaciones Fotovoltaicas",
    copy: "Reactivar la captación residencial y empresarial con recorridos comerciales propios.",
  },
  {
    marker: "H",
    title: "Helios",
    copy: "Unir captación, contratación, asignación de energía, documentación, cobros, facturación y gestión para crecer sin multiplicar la complejidad.",
    featured: true,
  },
] as const;

export const teamUpdates = [
  {
    initials: "PB",
    name: "Pablo Bordas",
    role: "CFO externo",
    title: "Refuerza la dirección financiera",
    copy: "Pablo se incorpora para mejorar la planificación financiera, el control de tesorería, el reporting, los indicadores de gestión y la organización administrativa del grupo.",
    mandate:
      "Su mandato inicial es ayudar a transformar la rentabilidad operativa en caja y reforzar la disciplina financiera.",
  },
  {
    initials: "CA",
    name: "Carlos Aguilera",
    role: "Director Comercial",
    title: "Asume la dirección comercial",
    copy: "Carlos se incorpora para reconstruir y liderar el equipo, ordenar los procesos comerciales y reactivar la captación de comuneros y nuevas cubiertas.",
    mandate:
      "Su primera etapa se centra en recuperar crecimiento con una oferta más competitiva y una capacidad de ejecución mayor.",
  },
] as const;

export const documentCategories = [
  {
    title: "Juntas y actas",
    copy: "Convocatorias, actas aprobadas y acuerdos societarios relevantes.",
  },
  {
    title: "Información financiera",
    copy: "Cuentas anuales, memorias, cierres y documentación financiera aprobada.",
  },
  {
    title: "Plan y estrategia",
    copy: "Presentaciones y resúmenes del roadmap expresamente aprobados para socios.",
  },
  {
    title: "Gobierno corporativo",
    copy: "Pactos, nombramientos y otros documentos societarios vigentes.",
  },
] as const;

export const publishedMaterials = [
  {
    kind: "Actualización a socios",
    date: "30 JUL 2026",
    title: "Una nueva etapa para Comunidad Solar",
    copy: "Lectura ejecutiva del cierre de 2025, prioridades inmediatas y próximos pasos.",
    href: "#resumen",
    action: "Leer actualización",
  },
  {
    kind: "Plan y estrategia",
    date: "30 JUL 2026",
    title: "Roadmap 2026–2027 · resumen ejecutivo",
    copy: "El plan resumido en tres horizontes, ordenados por plazo y nivel de certeza.",
    href: "#roadmap",
    action: "Consultar roadmap",
  },
  {
    kind: "Información financiera",
    date: "30 JUL 2026",
    title: "Resultados agrupados de gestión · 2025",
    copy: "Magnitudes agrupadas, explicación de tesorería y cartera de subvenciones.",
    href: "#finanzas",
    action: "Ver información",
  },
] as const;
