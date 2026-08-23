/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

declare module "*.sql?raw" {
  const source: string;
  export default source;
}

interface Env {
  readonly MANGANAFER_QUOTING_BEARER_TOKEN?: string;
  readonly MANGANAFER_PANEL_MONTHLY_FEE?: string;
  readonly MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT?: string;
  readonly MANGANAFER_PANEL_FEE_VAT?: string;
  readonly MANGANAFER_AVAILABLE_PANELS?: string;
  readonly MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH?: string;
  readonly MANGANAFER_DISCOUNT?: string;
  readonly MANGANAFER_PANEL_POWER_W?: string;
  readonly MANGANAFER_ANNUAL_DEGRADATION?: string;
  readonly MANGANAFER_MAXIMUM_PANELS_PER_QUOTE?: string;
}

declare namespace Cloudflare {
  interface Env {
    readonly MANGANAFER_QUOTING_BEARER_TOKEN?: string;
    readonly MANGANAFER_PANEL_MONTHLY_FEE?: string;
    readonly MANGANAFER_PANEL_MONTHLY_FEE_WITHOUT_VAT?: string;
    readonly MANGANAFER_PANEL_FEE_VAT?: string;
    readonly MANGANAFER_AVAILABLE_PANELS?: string;
    readonly MANGANAFER_ANNUAL_PANEL_PRODUCTION_KWH?: string;
    readonly MANGANAFER_DISCOUNT?: string;
    readonly MANGANAFER_PANEL_POWER_W?: string;
    readonly MANGANAFER_ANNUAL_DEGRADATION?: string;
    readonly MANGANAFER_MAXIMUM_PANELS_PER_QUOTE?: string;
  }
}
