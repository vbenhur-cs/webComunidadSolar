import type {
  Community,
  CommunityInstallation,
} from "../../../content/community-data.ts";

export const communityNumber = new Intl.NumberFormat("es-ES", {
  maximumFractionDigits: 3,
});

export const communityCurrency = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const communityPercentage = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 5,
});

export function formatCommunityInteger(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export const localCommunityFaqs = [
  {
    question: "¿Tengo que instalar paneles en mi casa?",
    answer:
      "No. Los paneles están en las cubiertas que forman la comunidad. Si tu dirección tiene cobertura, se te asigna una parte de su producción y la recibes en tu factura sin hacer obras en tu vivienda o negocio.",
  },
  {
    question: "¿Cómo sé si mi dirección está dentro de la cobertura?",
    answer:
      "Helios comprueba tu dirección y el punto de suministro. La proximidad se calcula respecto a la instalación que genera la energía y la compatibilidad final depende también de la red de distribución.",
  },
  {
    question: "¿Cómo se decide cuánta energía recibo?",
    answer:
      "La propuesta se ajusta a tu consumo y al número de paneles o producción que contrates. Esa participación se traduce en un coeficiente de reparto: la distribuidora lo aplica a las medidas y la comercializadora refleja la energía asignada en tu factura.",
  },
  {
    question: "¿Qué ocurre si no hay cobertura o no quedan plazas?",
    answer:
      "Helios comprueba si existe otra comunidad cercana que encaje contigo. Si no la hay, puede proponerte Autoconsumo Remoto para que también puedas acceder a producción solar sin instalar paneles en casa.",
  },
];

export function hasQuantifiedAvailability(status?: string): boolean {
  return /plazas disponibles|última plaza|últimas plazas|participación completa/i.test(
    status ?? "",
  );
}

export function hasConfirmedInstallationStatus(status?: string): boolean {
  return Boolean(
    status &&
    !/no publicado|por confirmar|pendiente de confirmación/i.test(status),
  );
}

export function getCommunityEnergySummary(
  community: Community,
): string | undefined {
  if (community.editorial?.energySummary) {
    return community.editorial.energySummary;
  }

  if (community.activationStatus?.billing.detail) {
    return community.activationStatus.billing.detail;
  }

  const explicitEnergyStates = Array.from(
    new Set(
      (community.installations ?? [])
        .map((installation) => installation.energyStatus)
        .filter((status): status is string => Boolean(status)),
    ),
  );

  if (explicitEnergyStates.length === 1) return explicitEnergyStates[0];
  if (explicitEnergyStates.length > 1) {
    return "Cada cubierta tiene un estado diferente";
  }

  const hasPublishedTechnicalProgress = (community.installations ?? []).some(
    (installation) =>
      hasConfirmedInstallationStatus(installation.technicalStatus),
  );

  return hasPublishedTechnicalProgress
    ? "Pendiente de activación en factura"
    : undefined;
}

export function getInstallationEnergyStatus(
  community: Community,
  installation: CommunityInstallation,
): string | undefined {
  if (installation.energyStatus) return installation.energyStatus;
  if (community.installations?.length === 1) {
    return getCommunityEnergySummary(community);
  }

  return hasConfirmedInstallationStatus(installation.technicalStatus)
    ? "Pendiente de activación en factura"
    : undefined;
}

export function hasActiveEnergyInBills(community: Community): boolean {
  return (
    community.activationStatus?.billing.tone === "done" ||
    (community.installations ?? []).some((installation) =>
      /reflejada|activa|reciben energía/i.test(installation.energyStatus ?? ""),
    )
  );
}

export function hasConnectedInstallation(community: Community): boolean {
  return (
    community.activationStatus?.connection.tone === "done" ||
    (community.installations ?? []).some((installation) =>
      /conectada a la red/i.test(installation.technicalStatus ?? ""),
    )
  );
}

export function getCommercialStateClass(status?: string): string {
  if (/participación completa/i.test(status ?? "")) {
    return "community-commercial-full";
  }
  if (/lista de espera/i.test(status ?? "")) {
    return "community-commercial-waitlist";
  }
  if (/próxima apertura|aún no abierta/i.test(status ?? "")) {
    return "community-commercial-upcoming";
  }
  return "community-commercial-open";
}
