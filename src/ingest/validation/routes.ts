import type { ChangePlan } from "../domain.ts";

function generatedRoutePath(plan: ChangePlan): string {
  return plan.targetPath === "/"
    ? "src/pages/index.astro"
    : `src/pages${plan.targetPath}.astro`;
}

function isCanonicalTargetPath(path: string): boolean {
  if (path === "/") return true;
  if (!path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segment));
}

/** Validates the route authority that the approved plan assigned to the output. */
export function validateGeneratedRoutes(
  plan: ChangePlan,
  files: ReadonlyMap<string, Buffer>,
): readonly string[] {
  const findings: string[] = [];
  if (!isCanonicalTargetPath(plan.targetPath)) {
    findings.push("route.canonical: la ruta debe usar segmentos URL canónicos");
  }

  const route = generatedRoutePath(plan);
  const declarations = plan.files.filter((file) => file.path === route);
  if (declarations.length !== 1) {
    findings.push("route.plan: el plan debe declarar una única ruta generada");
  } else {
    const expectedOperation = plan.overwritesExistingRoute
      ? "modify"
      : "create";
    if (declarations[0]?.operation !== expectedOperation) {
      findings.push(
        "route.collision: la operación de la ruta no coincide con la colisión aprobada",
      );
    }
  }

  if (!files.has(route)) {
    findings.push("route.output: falta el archivo de ruta planificado");
  }
  return findings;
}
