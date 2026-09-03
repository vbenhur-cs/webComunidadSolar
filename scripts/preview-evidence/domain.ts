import { createHash } from "node:crypto";

export { canonicalJson } from "../../src/ingest/canonical-json.ts";

export type AllowedHttpStatus = 200 | 301 | 302 | 307 | 308 | 404 | 410;
export type EvidenceRole = "base" | "candidate" | "release";
export type EvidenceScope = "page" | "section";

export interface EvidenceRequest {
  schemaVersion: 1;
  issue: number;
  scope: EvidenceScope;
  route: string;
  selector: string | null;
  expectedStatus: {
    base: AllowedHttpStatus;
    candidate: AllowedHttpStatus;
  };
  viewports: readonly ["desktop", "mobile"];
}

export const EVIDENCE_REQUEST_PATH =
  /^evidence\/requests\/issue-([1-9][0-9]*)\.yaml$/u;

export const PRIVATE_ROUTE_PREFIXES = [
  "/api",
  "/socios",
  "/guia-equipo",
  "/manganafer/interesados",
] as const;

export const EVIDENCE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
] as const;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
