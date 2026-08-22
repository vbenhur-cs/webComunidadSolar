import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { resolveDeploymentTopology } from "./parity-http.ts";
import {
  PHASE3_DEFERRED_PUBLIC_ROUTES,
  isPhase3DeferredPublicRoute,
} from "../src/lib/site/public-route-closure.ts";
import {
  readExistingRouteMatrix,
  type RouteMatrixEntry,
} from "./lib/route-inventory.ts";
import { siteUrl } from "../src/lib/seo/metadata.ts";

const localOrigin = "http://localhost";
const publicOrigin = new URL(siteUrl).origin;
const defaultLinkWorkerLifecycleTimeoutMs = 30_000;

export interface LinkDocument {
  path: string;
  html: string;
}

export interface LinkViolation {
  sourcePath: string;
  targetPath: string;
  reason: "fragment-missing" | "manifest-missing" | "status-mismatch";
  expectedStatus?: number;
  actualStatus?: number;
}

export interface DeferredLink {
  sourcePath: string;
  targetPath: string;
  owner: "Phase 3";
  reason: string;
}

export interface LinkAuditReport {
  checkedLinks: number;
  violations: LinkViolation[];
  deferred: DeferredLink[];
}

export interface VerifyInternalLinksOptions {
  root?: string;
  documents?: readonly LinkDocument[];
  routes?: readonly RouteMatrixEntry[];
  fetchPath?: (path: string) => Promise<Response>;
  /** Test seam for bounded Wrangler startup. */
  startWorker?: LinkWorkerStarter;
  /** Shared readiness, request, and bounded cleanup budget. */
  lifecycleTimeoutMs?: number;
}

export interface LinkWorker {
  ready: Promise<unknown>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  raw: { teardown(): Promise<void> };
}

export type LinkWorkerStarter = () => Promise<LinkWorker>;

function preserveLinkFailure(
  primaryFailure: unknown,
  cleanupFailure: unknown,
): void {
  if (!(primaryFailure instanceof Error)) return;
  try {
    const existingCause = (primaryFailure as Error & { cause?: unknown }).cause;
    Object.defineProperty(primaryFailure, "cause", {
      configurable: true,
      value:
        existingCause === undefined
          ? cleanupFailure
          : new AggregateError(
              [existingCause, cleanupFailure],
              "También falló la limpieza del Worker de enlaces",
            ),
    });
  } catch {
    // Keep the ready failure actionable even if its cause cannot be attached.
  }
}

function linkWorkerPhaseTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "El timeout del Worker de enlaces debe ser un entero positivo",
    );
  }
  return Math.max(1, Math.floor((timeoutMs - 1) / 2));
}

async function withinLinkWorkerTimeout<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `El Worker de enlaces superó ${timeoutMs} ms durante ${stage}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function disposeLinkWorker(
  worker: LinkWorker,
  timeoutMs = defaultLinkWorkerLifecycleTimeoutMs,
): Promise<void> {
  const phaseTimeoutMs = linkWorkerPhaseTimeout(timeoutMs);
  let disposeFailure: unknown;
  try {
    await withinLinkWorkerTimeout(
      "cerrar el Worker de enlaces",
      worker.dispose(),
      phaseTimeoutMs,
    );
  } catch (error) {
    disposeFailure = error;
  }
  if (disposeFailure === undefined) return;

  try {
    await withinLinkWorkerTimeout(
      "forzar teardown del Worker de enlaces",
      worker.raw.teardown(),
      phaseTimeoutMs,
    );
  } catch (teardownFailure) {
    preserveLinkFailure(disposeFailure, teardownFailure);
  }
  throw disposeFailure;
}

export async function createLinkWorkerRuntime(
  worker: LinkWorker,
  timeoutMs = defaultLinkWorkerLifecycleTimeoutMs,
): Promise<{
  fetchPath(path: string): Promise<Response>;
  dispose(): Promise<void>;
}> {
  try {
    await withinLinkWorkerTimeout(
      "esperar el Worker de enlaces listo",
      worker.ready,
      timeoutMs,
    );
  } catch (error) {
    try {
      await disposeLinkWorker(worker, timeoutMs);
    } catch (cleanupFailure) {
      preserveLinkFailure(error, cleanupFailure);
    }
    throw error;
  }
  return {
    fetchPath: async (path) =>
      withinLinkWorkerTimeout(
        `resolver el enlace ${path}`,
        worker.fetch(`${localOrigin}${path}`, { redirect: "manual" }),
        timeoutMs,
      ),
    dispose: async () => disposeLinkWorker(worker, timeoutMs),
  };
}

/**
 * A timed-out starter may still resolve later without a cancellable Wrangler
 * API. Dispose that late Worker immediately; a Worker acquired before the
 * deadline is always handed to the bounded ready/cleanup path before return.
 */
export async function startLinkWorkerRuntime(
  startWorker: LinkWorkerStarter,
  timeoutMs = defaultLinkWorkerLifecycleTimeoutMs,
): Promise<{
  fetchPath(path: string): Promise<Response>;
  dispose(): Promise<void>;
}> {
  const workerPromise = Promise.resolve().then(startWorker);
  let worker: LinkWorker;
  try {
    worker = await withinLinkWorkerTimeout(
      "iniciar el Worker de enlaces",
      workerPromise,
      timeoutMs,
    );
  } catch (error) {
    void workerPromise.then(
      async (lateWorker) => {
        try {
          await disposeLinkWorker(lateWorker, timeoutMs);
        } catch {
          // The startup timeout remains the actionable failure.
        }
      },
      () => undefined,
    );
    throw error;
  }
  return createLinkWorkerRuntime(worker, timeoutMs);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) throw new Error(`Ruta interna inválida: ${path}`);
  return path === "/" ? path : path.replace(/\/$/, "");
}

function routePathFromHtmlFile(root: string, file: string): string {
  const portable = relative(root, file).split(sep).join("/");
  if (portable === "index.html") return "/";
  if (portable.endsWith("/index.html")) {
    return normalizePath(`/${portable.slice(0, -"/index.html".length)}`);
  }
  if (portable.endsWith(".html")) {
    return normalizePath(`/${portable.slice(0, -".html".length)}`);
  }
  throw new Error(`HTML público inválido: ${portable}`);
}

async function collectHtmlDocuments(
  directory: string,
): Promise<LinkDocument[]> {
  const documents: LinkDocument[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (left, right) => compareText(left.name, right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        documents.push({
          path: routePathFromHtmlFile(directory, path),
          html: await readFile(path, "utf8"),
        });
      }
    }
  }
  await visit(directory);
  return documents.sort((left, right) => compareText(left.path, right.path));
}

function hrefs(html: string): string[] {
  return [
    ...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
  ].map((match) => (match[1] ?? match[2] ?? "").replaceAll("&amp;", "&"));
}

function hasId(html: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bid=(?:"${escaped}"|'${escaped}')`).test(html);
}

function isInternalHref(href: string): boolean {
  if (href.startsWith("#")) return true;
  if (href.startsWith("//")) return false;
  if (href.startsWith("/")) return true;
  try {
    const target = new URL(href, localOrigin);
    return target.origin === localOrigin || target.origin === publicOrigin;
  } catch {
    return false;
  }
}

function deferredLink(sourcePath: string, targetPath: string): DeferredLink {
  const route = PHASE3_DEFERRED_PUBLIC_ROUTES.find(
    (candidate) => candidate.path === targetPath,
  );
  if (route === undefined)
    throw new Error(`Ruta diferida desconocida: ${targetPath}`);
  return { sourcePath, targetPath, owner: route.owner, reason: route.reason };
}

async function startBuiltWorker(
  root: string,
  timeoutMs: number,
  injectedStarter?: LinkWorkerStarter,
): Promise<{
  fetchPath(path: string): Promise<Response>;
  dispose(): Promise<void>;
}> {
  const startWorker =
    injectedStarter ??
    (async (): Promise<LinkWorker> => {
      const topology = await resolveDeploymentTopology(root);
      const { unstable_startWorker } = await import("wrangler");
      return (await unstable_startWorker({
        config: topology.wranglerConfigPath,
        entrypoint: topology.entryPath,
        dev: {
          server: { hostname: "127.0.0.1", port: 0, secure: false },
          logLevel: "error",
          persist: false,
          remote: false,
          watch: false,
        },
      } as Parameters<
        typeof unstable_startWorker
      >[0])) as unknown as LinkWorker;
    });
  return startLinkWorkerRuntime(startWorker, timeoutMs);
}

export async function auditInternalLinks(
  options: VerifyInternalLinksOptions = {},
): Promise<LinkAuditReport> {
  const root = resolve(options.root ?? process.cwd());
  const routes = options.routes ?? (await readExistingRouteMatrix(root));
  const documents =
    options.documents ??
    (await collectHtmlDocuments(join(root, "dist", "client")));
  const documentByPath = new Map(
    documents.map((document) => [normalizePath(document.path), document]),
  );
  const routesByPath = new Map(
    routes.map((route) => [normalizePath(route.path), route]),
  );
  const violations: LinkViolation[] = [];
  const deferred: DeferredLink[] = [];
  const fetched = new Map<string, Promise<Response>>();
  let runtime: Awaited<ReturnType<typeof startBuiltWorker>> | undefined;
  let fetchPath = options.fetchPath;
  const lifecycleTimeoutMs =
    options.lifecycleTimeoutMs ?? defaultLinkWorkerLifecycleTimeoutMs;
  let report!: LinkAuditReport;
  let primaryFailure: unknown;
  let failed = false;

  try {
    if (fetchPath === undefined) {
      runtime = await startBuiltWorker(
        root,
        lifecycleTimeoutMs,
        options.startWorker,
      );
      fetchPath = runtime.fetchPath;
    }

    const fetchTarget = (path: string): Promise<Response> => {
      const existing = fetched.get(path);
      if (existing !== undefined) return existing;
      const next = fetchPath!(path);
      fetched.set(path, next);
      return next;
    };

    let checkedLinks = 0;
    for (const document of documents) {
      const sourcePath = normalizePath(document.path);
      for (const href of hrefs(document.html)) {
        if (!isInternalHref(href)) continue;
        checkedLinks += 1;
        const target = new URL(href, `${localOrigin}${sourcePath}`);
        const targetPath = normalizePath(target.pathname);
        const targetWithFragment = `${targetPath}${target.hash}`;

        if (isPhase3DeferredPublicRoute(targetPath)) {
          deferred.push(deferredLink(sourcePath, targetPath));
          continue;
        }

        const route = routesByPath.get(targetPath);
        if (route === undefined) {
          violations.push({
            sourcePath,
            targetPath: targetWithFragment,
            reason: "manifest-missing",
          });
          continue;
        }

        if (target.hash && targetPath === sourcePath) {
          const id = decodeURIComponent(target.hash.slice(1));
          if (!hasId(document.html, id)) {
            violations.push({
              sourcePath,
              targetPath: targetWithFragment,
              reason: "fragment-missing",
            });
          }
          continue;
        }

        const response = await fetchTarget(`${targetPath}${target.search}`);
        if (response.status !== route.expectedStatus) {
          violations.push({
            sourcePath,
            targetPath: targetWithFragment,
            reason: "status-mismatch",
            expectedStatus: route.expectedStatus,
            actualStatus: response.status,
          });
          continue;
        }

        if (target.hash) {
          const id = decodeURIComponent(target.hash.slice(1));
          const targetHtml =
            documentByPath.get(targetPath)?.html ?? (await response.text());
          if (!hasId(targetHtml, id)) {
            violations.push({
              sourcePath,
              targetPath: targetWithFragment,
              reason: "fragment-missing",
            });
          }
        }
      }
    }

    report = { checkedLinks, violations, deferred };
  } catch (error) {
    failed = true;
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await runtime?.dispose();
  } catch (error) {
    cleanupFailure = error;
  }
  if (failed) {
    if (cleanupFailure !== undefined) {
      preserveLinkFailure(primaryFailure, cleanupFailure);
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return report;
}

export async function verifyInternalLinks(
  options: VerifyInternalLinksOptions = {},
): Promise<LinkViolation[]> {
  return (await auditInternalLinks(options)).violations;
}

async function main(): Promise<void> {
  const report = await auditInternalLinks();
  for (const item of report.deferred) {
    process.stdout.write(
      `LINK_DEFERRED source=${item.sourcePath} target=${item.targetPath} owner=${item.owner} reason=${item.reason}\n`,
    );
  }
  for (const violation of report.violations) {
    process.stderr.write(
      `LINK_VIOLATION source=${violation.sourcePath} target=${violation.targetPath} reason=${violation.reason}${violation.expectedStatus === undefined ? "" : ` expected=${violation.expectedStatus} actual=${violation.actualStatus}`}\n`,
    );
  }
  if (report.violations.length > 0) {
    throw new Error(
      `verify-links encontró ${report.violations.length} enlaces inválidos`,
    );
  }
  process.stdout.write(
    `LINKS_OK checked=${report.checkedLinks} deferred=${report.deferred.length}\n`,
  );
}

if (process.argv[1]?.endsWith("verify-links.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
