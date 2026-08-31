import { readFileSync } from "node:fs";

import Ajv from "ajv";

import type { PrivateArea } from "../ingest/domain.ts";

export const APPROVED_BLOCK_TYPES = Object.freeze([
  "hero",
  "feature",
  "cta",
  "steps",
  "faq",
  "trust",
] as const);

export interface BlockLink {
  label: string;
  href: string;
}

export interface HeroBlockDefinition {
  type: "hero";
  eyebrow: string;
  title: string;
  lead: string;
  primary?: BlockLink;
  secondary?: BlockLink;
}

export interface FeatureBlockDefinition {
  type: "feature";
  title: string;
  items: Array<{ title: string; copy: string }>;
}

export interface CtaBlockDefinition {
  type: "cta";
  title: string;
  copy: string;
  action: BlockLink;
}

export interface StepsBlockDefinition {
  type: "steps";
  title: string;
  steps: Array<{ title: string; copy: string }>;
}

export interface FaqBlockDefinition {
  type: "faq";
  title: string;
  items: Array<{ question: string; answer: string }>;
}

export interface TrustBlockDefinition {
  type: "trust";
  title: string;
  items: Array<{ label: string; detail: string }>;
}

export type ApprovedBlockDefinition =
  | HeroBlockDefinition
  | FeatureBlockDefinition
  | CtaBlockDefinition
  | StepsBlockDefinition
  | FaqBlockDefinition
  | TrustBlockDefinition;

export interface BlockPageDefinition {
  schemaVersion: 1;
  changeId: string;
  mode: "blocks";
  route: `/${string}`;
  metadata: {
    title: string | null;
    description: string | null;
    index: boolean;
  };
  privacy: { private: boolean; area: PrivateArea | null };
  contentSha256: string;
  blocks: ApprovedBlockDefinition[];
}

const schema = JSON.parse(
  readFileSync(
    new URL("../../schemas/ingestion/block-page.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const validate = new Ajv({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
}).compile(schema);

export function validateBlockPage(value: unknown): BlockPageDefinition {
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? error.keyword}`,
      )
      .join("; ");
    throw new TypeError(
      `El bloque o la página usa contenido no aprobado por el schema: ${details}`,
    );
  }
  return value as BlockPageDefinition;
}
