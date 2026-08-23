export type ManganaferQuoteEnvironment = Pick<
  Env,
  | "MANGANAFER_QUOTING_BEARER_TOKEN"
  | "MANGANAFER_PANEL_MONTHLY_FEE"
  | "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT"
  | "MANGANAFER_PANEL_FEE_VAT"
  | "MANGANAFER_AVAILABLE_PANELS"
  | "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH"
  | "MANGANAFER_DISCOUNT"
  | "MANGANAFER_PANEL_POWER_W"
  | "MANGANAFER_ANNUAL_DEGRADATION"
  | "MANGANAFER_MAXIMUM_PANELS_PER_QUOTE"
>;

export function selectManganaferQuoteEnvironment<
  Bindings extends ManganaferQuoteEnvironment,
>(bindings: Bindings): ManganaferQuoteEnvironment {
  return {
    MANGANAFER_QUOTING_BEARER_TOKEN: bindings.MANGANAFER_QUOTING_BEARER_TOKEN,
    MANGANAFER_PANEL_MONTHLY_FEE: bindings.MANGANAFER_PANEL_MONTHLY_FEE,
    MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT:
      bindings.MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT,
    MANGANAFER_PANEL_FEE_VAT: bindings.MANGANAFER_PANEL_FEE_VAT,
    MANGANAFER_AVAILABLE_PANELS: bindings.MANGANAFER_AVAILABLE_PANELS,
    MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH:
      bindings.MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH,
    MANGANAFER_DISCOUNT: bindings.MANGANAFER_DISCOUNT,
    MANGANAFER_PANEL_POWER_W: bindings.MANGANAFER_PANEL_POWER_W,
    MANGANAFER_ANNUAL_DEGRADATION: bindings.MANGANAFER_ANNUAL_DEGRADATION,
    MANGANAFER_MAXIMUM_PANELS_PER_QUOTE:
      bindings.MANGANAFER_MAXIMUM_PANELS_PER_QUOTE,
  };
}

export type ManganaferQuoteConfig = {
  bearerToken: string;
  monthlyPanelFee: number;
  monthlyPanelFeeWithoutVat: number;
  vat: number;
  availablePanels: number;
  annualPanelProductionKwh: number;
  discount: number;
  panelPowerW: number;
  annualDegradation: number;
  maximumPanelsPerQuote: number;
  projectYears: number;
};

type RequiredNumberVariable =
  | "MANGANAFER_PANEL_MONTHLY_FEE"
  | "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT"
  | "MANGANAFER_PANEL_FEE_VAT"
  | "MANGANAFER_AVAILABLE_PANELS"
  | "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH"
  | "MANGANAFER_DISCOUNT"
  | "MANGANAFER_PANEL_POWER_W"
  | "MANGANAFER_ANNUAL_DEGRADATION";

function configuredNumber(
  environment: ManganaferQuoteEnvironment,
  name: RequiredNumberVariable,
): number | null {
  const value = Number(environment[name]);
  return Number.isFinite(value) ? value : null;
}

export function getManganaferQuoteConfig(
  environment: ManganaferQuoteEnvironment,
): ManganaferQuoteConfig | null {
  const bearerToken = environment.MANGANAFER_QUOTING_BEARER_TOKEN?.trim() ?? "";
  const monthlyPanelFee = configuredNumber(
    environment,
    "MANGANAFER_PANEL_MONTHLY_FEE",
  );
  const monthlyPanelFeeWithoutVat = configuredNumber(
    environment,
    "MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT",
  );
  const vat = configuredNumber(environment, "MANGANAFER_PANEL_FEE_VAT");
  const availablePanels = configuredNumber(
    environment,
    "MANGANAFER_AVAILABLE_PANELS",
  );
  const annualPanelProductionKwh = configuredNumber(
    environment,
    "MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH",
  );
  const discount = configuredNumber(environment, "MANGANAFER_DISCOUNT");
  const panelPowerW = configuredNumber(environment, "MANGANAFER_PANEL_POWER_W");
  const annualDegradation = configuredNumber(
    environment,
    "MANGANAFER_ANNUAL_DEGRADATION",
  );

  if (
    !bearerToken ||
    monthlyPanelFee === null ||
    monthlyPanelFeeWithoutVat === null ||
    vat === null ||
    availablePanels === null ||
    annualPanelProductionKwh === null ||
    discount === null ||
    panelPowerW === null ||
    annualDegradation === null ||
    monthlyPanelFee < 0 ||
    monthlyPanelFeeWithoutVat < 0 ||
    vat < 0 ||
    vat > 1 ||
    availablePanels < 1 ||
    annualPanelProductionKwh <= 0 ||
    discount < 0 ||
    discount > 1 ||
    panelPowerW <= 0 ||
    annualDegradation < 0 ||
    annualDegradation > 1
  ) {
    return null;
  }

  const configuredMaximum = Number(
    environment.MANGANAFER_MAXIMUM_PANELS_PER_QUOTE,
  );
  const maximumPanelsPerQuote = Number.isFinite(configuredMaximum)
    ? Math.max(1, Math.min(Math.floor(configuredMaximum), 24))
    : 12;

  return {
    bearerToken,
    monthlyPanelFee,
    monthlyPanelFeeWithoutVat,
    vat,
    availablePanels: Math.floor(availablePanels),
    annualPanelProductionKwh,
    discount,
    panelPowerW: Math.round(panelPowerW),
    annualDegradation,
    maximumPanelsPerQuote,
    projectYears: 25,
  };
}

export function isManganaferCalculatorConfigured(
  environment: ManganaferQuoteEnvironment,
): boolean {
  return getManganaferQuoteConfig(environment) !== null;
}
