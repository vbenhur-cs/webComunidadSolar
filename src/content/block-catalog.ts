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

const publicSiteOrigin = "https://comunidadsolar.es";
const encodedForbiddenUrlCharacter = /%(?:0[0-9a-f]|1[0-9a-f]|20|5c|7f)/iu;

function hasForbiddenUrlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f || character === "\\";
  });
}

/** Closed URL authority shared by block JSON and generated Astro markup. */
export function isApprovedGeneratedLink(value: string): boolean {
  if (
    value.length === 0 ||
    hasForbiddenUrlCharacter(value) ||
    encodedForbiddenUrlCharacter.test(value)
  ) {
    return false;
  }
  if (value.startsWith("#")) return true;
  if (value.startsWith("mailto:")) {
    return /^mailto:[^@:?]+@[^@:?]+$/u.test(value);
  }
  if (value.startsWith("tel:")) {
    return /^tel:\+?[0-9().-]+$/u.test(value);
  }
  try {
    const url = new URL(value, publicSiteOrigin);
    if (url.username !== "" || url.password !== "") return false;
    if (value.startsWith("/")) {
      return !value.startsWith("//") && url.origin === publicSiteOrigin;
    }
    return value.startsWith("https://") && url.origin === publicSiteOrigin;
  } catch {
    return false;
  }
}

function assertApprovedBlockLinks(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertApprovedBlockLinks(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "href" &&
      (typeof child !== "string" || !isApprovedGeneratedLink(child))
    ) {
      throw new TypeError("El enlace usa un origen o protocolo no aprobado");
    }
    assertApprovedBlockLinks(child);
  }
}

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
  assertApprovedBlockLinks(value);
  return value as BlockPageDefinition;
}
