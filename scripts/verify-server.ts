import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readExistingRouteMatrix,
  type RouteMatrixEntry,
} from "./lib/route-inventory.ts";
import { isServerRoute } from "./parity-http.ts";

interface ServerContractEvidence {
  routeKey: string;
  bodyCapture: string;
  bodyComparison?: string;
}

interface ServerBaseline {
  contracts: readonly ServerContractEvidence[];
}

interface ServerMatrixEntry {
  kind: string;
  path: string;
  status: string;
}

export interface ServerVerification {
  apiContracts: number;
  apiRoutes: number;
  privateRoutes: number;
  serverRoutes: number;
}

export interface VerifyServerOptions {
  root?: string;
  readMatrix?: () => Promise<readonly ServerMatrixEntry[]>;
  readBaseline?: () => Promise<ServerBaseline>;
}

const expectedServerRouteKeys = new Set([
  "api:/api/manganafer-interest",
  "api:/api/manganafer-interest/export",
  "api:/api/manganafer-quote",
  "private-page:/guia-equipo",
  "private-page:/guia-equipo-nueva-web-comunidad-solar.md",
  "private-page:/manganafer/interesados",
  "private-page:/socios",
]);

const expectedApiContractKeys = new Set([
  "api:/api/manganafer-interest/export|GET|anonymous|default",
  "api:/api/manganafer-interest/export|GET|denied|default",
  "api:/api/manganafer-interest/export|GET|unconfigured|default",
  "api:/api/manganafer-interest|POST|anonymous|invalid-form",
  "api:/api/manganafer-quote|POST|anonymous|invalid-cups",
  "api:/api/manganafer-quote|POST|anonymous|unconfigured",
]);

function routeKey(entry: Pick<ServerMatrixEntry, "kind" | "path">): string {
  return `${entry.kind}:${entry.path}`;
}

function parseContractRouteKey(routeKeyValue: string): {
  kind: string;
  path: string;
} {
  const [route, method, identity, variant, extra] = routeKeyValue.split("|");
  const separator = route?.indexOf(":") ?? -1;
  if (
    route === undefined ||
    method === undefined ||
    identity === undefined ||
    variant === undefined ||
    extra !== undefined ||
    separator <= 0
  ) {
    throw new Error(`routeKey HTTP inválido: ${routeKeyValue}`);
  }
  const kind = route.slice(0, separator);
  const path = route.slice(separator + 1).split("?", 1)[0] ?? "";
  if (!path.startsWith("/")) {
    throw new Error(`path HTTP inválido: ${routeKeyValue}`);
  }
  return { kind, path };
}

function assertExactServerRouteSet(matrix: readonly ServerMatrixEntry[]): {
  api: ServerMatrixEntry[];
  privatePages: ServerMatrixEntry[];
} {
  const server = matrix.filter((entry) => {
    isServerRoute(entry);
    return entry.kind === "api" || entry.kind === "private-page";
  });
  const actual = new Set(server.map(routeKey));
  if (
    server.length !== expectedServerRouteKeys.size ||
    actual.size !== expectedServerRouteKeys.size ||
    [...expectedServerRouteKeys].some((key) => !actual.has(key))
  ) {
    const received = [...actual].sort().join(", ") || "(none)";
    throw new Error(
      `Las rutas server no coinciden con el cierre de Fase 3: ${received}`,
    );
  }
  for (const entry of server) {
    if (entry.status !== "verified") {
      throw new Error(`Ruta server no verificada: ${routeKey(entry)}`);
    }
  }
  return {
    api: server.filter((entry) => entry.kind === "api"),
    privatePages: server.filter((entry) => entry.kind === "private-page"),
  };
}

function assertContractMatrixMapping(
  contracts: readonly ServerContractEvidence[],
  matrix: readonly ServerMatrixEntry[],
): void {
  const matrixKeys = new Set(matrix.map(routeKey));
  for (const contract of contracts) {
    const parsed = parseContractRouteKey(contract.routeKey);
    isServerRoute(parsed);
    if (!matrixKeys.has(`${parsed.kind}:${parsed.path}`)) {
      throw new Error(`Contrato HTTP sin fila de matriz: ${contract.routeKey}`);
    }
  }
}

function assertApiEvidence(
  api: readonly ServerMatrixEntry[],
  contracts: readonly ServerContractEvidence[],
): number {
  const apiContracts = contracts.filter(
    (contract) => parseContractRouteKey(contract.routeKey).kind === "api",
  );
  const apiContractKeys = new Set(
    apiContracts.map((contract) => contract.routeKey),
  );
  for (const entry of api) {
    const key = routeKey(entry);
    if (
      !apiContracts.some((contract) => {
        const parsed = parseContractRouteKey(contract.routeKey);
        return `${parsed.kind}:${parsed.path}` === key;
      })
    ) {
      throw new Error(`API de servidor sin contrato HTTP capturado: ${key}`);
    }
  }
  if (
    apiContractKeys.size !== expectedApiContractKeys.size ||
    [...expectedApiContractKeys].some((key) => !apiContractKeys.has(key)) ||
    [...apiContractKeys].some((key) => !expectedApiContractKeys.has(key))
  ) {
    throw new Error(
      "Los contratos API server no coinciden con la evidencia capturada",
    );
  }
  for (const contract of apiContracts) {
    if (
      contract.bodyCapture !== "captured" ||
      contract.bodyComparison !== "exact"
    ) {
      throw new Error(
        `Contrato API server debe ser exacto y capturado: ${contract.routeKey}`,
      );
    }
  }
  return apiContracts.length;
}

function assertPrivateRouteEvidence(
  privatePages: readonly ServerMatrixEntry[],
  contracts: readonly ServerContractEvidence[],
): void {
  for (const entry of privatePages) {
    const key = routeKey(entry);
    if (
      !contracts.some((contract) => {
        const parsed = parseContractRouteKey(contract.routeKey);
        return `${parsed.kind}:${parsed.path}` === key;
      })
    ) {
      throw new Error(`Ruta privada sin contrato HTTP previo: ${key}`);
    }
  }
}

async function readBaselineFromDisk(root: string): Promise<ServerBaseline> {
  const parsed: unknown = JSON.parse(
    await readFile(join(root, "parity", "http-contracts.json"), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { contracts?: unknown }).contracts)
  ) {
    throw new Error("parity/http-contracts.json inválido");
  }
  const contracts: ServerContractEvidence[] = (
    parsed as { contracts: unknown[] }
  ).contracts.map((contract) => {
    if (
      typeof contract !== "object" ||
      contract === null ||
      typeof (contract as { routeKey?: unknown }).routeKey !== "string" ||
      typeof (contract as { bodyCapture?: unknown }).bodyCapture !== "string"
    ) {
      throw new Error("Contrato HTTP server inválido");
    }
    const candidate = contract as {
      routeKey: string;
      bodyCapture: string;
      bodyComparison?: unknown;
    };
    if (
      candidate.bodyComparison !== undefined &&
      typeof candidate.bodyComparison !== "string"
    ) {
      throw new Error("Contrato HTTP server inválido");
    }
    return {
      routeKey: candidate.routeKey,
      bodyCapture: candidate.bodyCapture,
      ...(typeof candidate.bodyComparison === "string"
        ? { bodyComparison: candidate.bodyComparison }
        : {}),
    };
  });
  return { contracts };
}

/**
 * Closes Phase 3 server inventory without reading private response bodies.
 * Private-page evidence is supplied by their existing HTTP/E2E/strict-visual
 * gates; API evidence remains the exact synthetic HTTP baseline.
 */
export async function verifyServer(
  options: VerifyServerOptions = {},
): Promise<ServerVerification> {
  const root = resolve(options.root ?? process.cwd());
  const readMatrix =
    options.readMatrix ??
    (async () => readExistingRouteMatrix(root) as Promise<RouteMatrixEntry[]>);
  const readBaseline =
    options.readBaseline ?? (async () => readBaselineFromDisk(root));
  const [matrix, baseline] = await Promise.all([readMatrix(), readBaseline()]);
  const server = assertExactServerRouteSet(matrix);
  assertContractMatrixMapping(baseline.contracts, matrix);
  const apiContracts = assertApiEvidence(server.api, baseline.contracts);
  assertPrivateRouteEvidence(server.privatePages, baseline.contracts);
  return {
    apiContracts,
    apiRoutes: server.api.length,
    privateRoutes: server.privatePages.length,
    serverRoutes: server.api.length + server.privatePages.length,
  };
}

async function main(): Promise<void> {
  const result = await verifyServer();
  process.stdout.write(
    `SERVER_VERIFY_OK routes=${result.serverRoutes} api=${result.apiRoutes} private=${result.privateRoutes} contracts=${result.apiContracts}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
