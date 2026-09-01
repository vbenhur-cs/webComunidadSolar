import { readFileSync } from "node:fs";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

export type IngestionSchemaName =
  | "request-input"
  | "normalized-request"
  | "change-plan"
  | "approval"
  | "attempt"
  | "candidate"
  | "candidate-dossier-preimage"
  | "agent-result";

function readSchema(name: IngestionSchemaName): object {
  const file = new URL(
    `../../schemas/ingestion/${name}.schema.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(file, "utf8")) as object;
}

const schemas: Record<IngestionSchemaName, object> = {
  "request-input": readSchema("request-input"),
  "normalized-request": readSchema("normalized-request"),
  "change-plan": readSchema("change-plan"),
  approval: readSchema("approval"),
  attempt: readSchema("attempt"),
  candidate: readSchema("candidate"),
  "candidate-dossier-preimage": readSchema("candidate-dossier-preimage"),
  "agent-result": readSchema("agent-result"),
};

const ajv = new Ajv({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
});
addFormats(ajv);

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<IngestionSchemaName, ValidateFunction>;

function validationMessage(
  name: IngestionSchemaName,
  validate: ValidateFunction,
): string {
  const details = (validate.errors ?? [])
    .map((error) => {
      const property =
        typeof error.params.additionalProperty === "string"
          ? `/${error.params.additionalProperty}`
          : error.instancePath || "/";
      return `${property} ${error.message ?? error.keyword}`;
    })
    .join("; ");
  return `El schema ${name} no es válido: ${details}`;
}

export function validateSchema<T>(
  name: IngestionSchemaName,
  value: unknown,
): T {
  const validate = validators[name];
  if (!validate(value)) {
    throw new TypeError(validationMessage(name, validate));
  }
  return value as T;
}
