import { sha256Canonical } from "../canonical-json.ts";
import type { ChangePlan, NormalizedRequest } from "../domain.ts";
import { assertNormalizedRequest } from "../importers/common.ts";
import { validateSchema } from "../schema-validator.ts";

function text(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function list(values: readonly string[]): string {
  return values.length === 0
    ? "- Ninguno."
    : values.map((value) => `- ${text(value)}`).join("\n");
}

function criterionValidation(index: number): string {
  return `acceptance-criterion-${index + 1}`;
}

/** Renders a reviewable, inert Markdown view of the exact hash-bound plan. */
export function renderPlanMarkdown(
  plan: ChangePlan,
  request: NormalizedRequest,
): string {
  const checkedPlan = validateSchema<ChangePlan>("change-plan", plan);
  const { planSha256, ...unsigned } = checkedPlan;
  if (planSha256 !== sha256Canonical(unsigned)) {
    throw new TypeError("El hash del plan no coincide");
  }
  const normalized = assertNormalizedRequest(request);
  if (checkedPlan.requestSha256 !== normalized.inputSha256) {
    throw new TypeError("El plan no corresponde a la solicitud");
  }
  const reused = checkedPlan.components.filter(
    (component) => !component.startsWith("generated/"),
  );
  const created = checkedPlan.components.filter((component) =>
    component.startsWith("generated/"),
  );
  const assetRows =
    normalized.assets.length === 0
      ? "| Ninguno | — | — |"
      : normalized.assets
          .map(
            (asset) =>
              `| ${text(asset.path)} | ${text(asset.mediaType)} | ${text(asset.sha256)} |`,
          )
          .join("\n");
  const criteria = normalized.acceptanceCriteria
    .map(
      (criterion, index) =>
        `| ${text(criterion)} | ${criterionValidation(index)} | Evidencia automática de ${criterionValidation(index)} |`,
    )
    .join("\n");

  return `# Plan de cambio: ${text(plan.changeId)}

## Resumen de entrada

- Intent: ${text(request.intent)}
- Tipo: ${text(request.inputKind)}
- Hash de solicitud: ${text(request.inputSha256)}
- Hash del plan: ${text(plan.planSha256)}
- Baseline: ${text(plan.baselineCommit)}

## Ruta y overwrite

- Ruta: ${text(plan.targetPath)}
- Overwrite de ruta existente: ${plan.overwritesExistingRoute ? "sí" : "no"}

## Modo de composición

- Modo seleccionado: ${text(plan.selectedMode)}

## Archivos previstos

${plan.files.map((file) => `- ${text(file.operation)}: ${text(file.path)}`).join("\n")}

## Componentes reutilizados y nuevos

### Reutilizados

${list(reused)}

### Nuevos

${list(created)}

## Islas

${list(plan.islands)}

## Assets

| Path | Tipo | SHA-256 |
| --- | --- | --- |
${assetRows}

## Claims, enlaces e integraciones

### Claims

${list(request.claims)}

### Enlaces declarados

${list(request.references)}

### Integraciones externas permitidas

${list(request.allowedExternalLinks)}

## Impacto SEO, privacidad y navegación

- SEO: título ${request.seo.title === null ? "no especificado" : text(request.seo.title)}; indexable ${request.seo.index ? "sí" : "no"}.
- Privacidad: ${request.privacy.private ? `privada (${text(request.privacy.area ?? "sin área")})` : "pública"}.
- Navegación: ${plan.validations.includes("navigation-links") ? "revisión de enlaces requerida" : "sin cambio previsto"}.

## Dependencias

${list(plan.dependencies)}

## Riesgos

- Gate 1 debe aprobar este hash antes de generar código.
- Cualquier cambio de baseline o perfil de publicación requiere un plan nuevo.
${plan.overwritesExistingRoute ? "- La ruta existente exige comparación visual y HTML.\n" : ""}

## Matriz de aceptación

| Criterio | Validación | Evidencia |
| --- | --- | --- |
${criteria}
`;
}
