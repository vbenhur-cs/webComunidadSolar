import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { openIngestionController } from "./controller.ts";

export type CliCommandResult =
  | { readonly kind: "success"; readonly value: Record<string, unknown> }
  | { readonly kind: "gate-pending"; readonly gate: 1 | 2 };

/** The narrow domain port consumed by the production command-line adapter. */
export interface CliController {
  receiveRequest(input: {
    readonly kind: "request" | "page";
    readonly source: string;
    readonly metadata?: string;
  }): Promise<CliCommandResult>;
  plan(changeId: string): Promise<CliCommandResult>;
  approve(input: {
    readonly changeId: string;
    readonly gate: 1 | 2;
    readonly actor: string;
  }): Promise<CliCommandResult>;
  generate(input: {
    readonly changeId: string;
    readonly adapter: "codex" | "command";
  }): Promise<CliCommandResult>;
  validate(changeId: string): Promise<CliCommandResult>;
  preview(input: {
    readonly changeId: string;
    readonly checkOnly: true;
  }): Promise<CliCommandResult>;
  status(changeId: string): Promise<CliCommandResult>;
  dispose?(): Promise<void>;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRunOptions {
  readonly controller?: CliController;
}

const usage = [
  "Uso:",
  "  ingest receive request <archivo>",
  "  ingest receive page <paquete> [--metadata <archivo>]",
  "  ingest plan <change-id>",
  "  ingest approve <change-id> --gate <1|2> [--actor <persona>]",
  "  ingest generate <change-id> --adapter <codex|command>",
  "  ingest validate <change-id>",
  "  ingest preview <change-id> --check-only",
  "  ingest status <change-id> [--json]",
].join("\n");

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "fallo operativo";
  return message
    .replace(/(?:[A-Za-z]:)?\/(?:[^\s:]+\/)*[^\s:]*/gu, "[ruta]")
    .replace(
      /(?:PRIVATE\s+KEY|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
      "[redactado]",
    )
    .slice(0, 240);
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function safeJson(value: unknown): unknown {
  if (typeof value === "string") {
    return isAbsoluteLike(value) ||
      /PRIVATE\s+KEY|secret|token|password/iu.test(value)
      ? "[redactado]"
      : value;
  }
  if (Array.isArray(value)) return value.map(safeJson);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      /path|secret|token|password|capability|credential|intake|stdout|stderr/iu.test(
        key,
      )
    ) {
      continue;
    }
    result[key] = safeJson(entry);
  }
  return result;
}

function serialized(value: unknown): string {
  return `${JSON.stringify(safeJson(value))}\n`;
}

function forbidden(message: string): CliRunResult {
  return { exitCode: 3, stdout: "", stderr: `${message}\n` };
}

function pending(gate: 1 | 2): CliRunResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `Gate ${gate.toString()} pendiente; la transición exige aprobación humana.\n`,
  };
}

function success(value: Record<string, unknown>, json: boolean): CliRunResult {
  const rendered = serialized(value);
  return {
    exitCode: 0,
    stdout: json ? rendered : rendered,
    stderr: "",
  };
}

function parsed(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      adapter: { type: "string" },
      metadata: { type: "string" },
      gate: { type: "string" },
      actor: { type: "string" },
      "check-only": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function exactPositionals(
  positionals: readonly string[],
  count: number,
): string[] | null {
  return positionals.length === count ? [...positionals] : null;
}

function hasOnlyCommandOptions(
  values: ReturnType<typeof parsed>["values"],
  allowed: readonly string[],
): boolean {
  return Object.keys(values).every(
    (key) => key === "help" || allowed.includes(key),
  );
}

async function promptActor(): Promise<string> {
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new TypeError(
      "La aprobación sin actor exige un terminal interactivo",
    );
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const actor = (await prompt.question("Actor humano responsable: ")).trim();
    if (actor === "")
      throw new TypeError("El actor de aprobación es obligatorio");
    return actor;
  } finally {
    prompt.close();
  }
}

async function execute(
  controller: CliController,
  argv: readonly string[],
): Promise<CliRunResult> {
  let args: ReturnType<typeof parsed>;
  try {
    args = parsed(argv);
  } catch (error) {
    return forbidden(`Opciones inválidas: ${safeError(error)}`);
  }
  const positionals = args.positionals;
  const values = args.values;
  if (values.help === true)
    return { exitCode: 0, stdout: `${usage}\n`, stderr: "" };
  const command = positionals[0];
  if (command === undefined) return forbidden(usage);
  if (command === "e2e" || command === "fixture") {
    return forbidden("Ese comando no forma parte de la CLI de producción");
  }

  let result: CliCommandResult;
  try {
    switch (command) {
      case "receive": {
        const input = exactPositionals(positionals, 3);
        const kind = input?.[1];
        const source = input?.[2];
        if (
          input === null ||
          (kind !== "request" && kind !== "page") ||
          source === undefined ||
          !hasOnlyCommandOptions(values, ["metadata"])
        ) {
          return forbidden(
            "receive exige request|page y un archivo de entrada",
          );
        }
        if (kind === "request" && values.metadata !== undefined) {
          return forbidden("--metadata sólo se permite al recibir una página");
        }
        result = await controller.receiveRequest({
          kind,
          source,
          ...(values.metadata === undefined
            ? {}
            : { metadata: values.metadata }),
        });
        break;
      }
      case "plan": {
        const input = exactPositionals(positionals, 2);
        if (
          input === null ||
          input[1] === undefined ||
          !hasOnlyCommandOptions(values, [])
        )
          return forbidden("plan exige un change-id");
        result = await controller.plan(input[1]);
        break;
      }
      case "approve": {
        const input = exactPositionals(positionals, 2);
        const gate = values.gate;
        if (
          input === null ||
          input[1] === undefined ||
          (gate !== "1" && gate !== "2") ||
          !hasOnlyCommandOptions(values, ["gate", "actor"])
        ) {
          return forbidden("approve exige --gate 1 o --gate 2");
        }
        const actor = values.actor ?? (await promptActor());
        result = await controller.approve({
          changeId: input[1],
          gate: gate === "1" ? 1 : 2,
          actor,
        });
        break;
      }
      case "generate": {
        const input = exactPositionals(positionals, 2);
        const adapter = values.adapter;
        if (
          input === null ||
          input[1] === undefined ||
          (adapter !== "codex" && adapter !== "command") ||
          !hasOnlyCommandOptions(values, ["adapter"])
        ) {
          return forbidden(
            "generate sólo admite --adapter codex o --adapter command",
          );
        }
        result = await controller.generate({ changeId: input[1], adapter });
        break;
      }
      case "validate": {
        const input = exactPositionals(positionals, 2);
        if (
          input === null ||
          input[1] === undefined ||
          !hasOnlyCommandOptions(values, [])
        )
          return forbidden("validate exige un change-id");
        result = await controller.validate(input[1]);
        break;
      }
      case "preview": {
        const input = exactPositionals(positionals, 2);
        if (
          input === null ||
          input[1] === undefined ||
          values["check-only"] !== true ||
          !hasOnlyCommandOptions(values, ["check-only"])
        ) {
          return forbidden("preview exige --check-only");
        }
        result = await controller.preview({
          changeId: input[1],
          checkOnly: true,
        });
        break;
      }
      case "status": {
        const input = exactPositionals(positionals, 2);
        if (
          input === null ||
          input[1] === undefined ||
          !hasOnlyCommandOptions(values, ["json"])
        )
          return forbidden("status exige un change-id");
        result = await controller.status(input[1]);
        break;
      }
      default:
        return forbidden(`Comando no permitido: ${command}`);
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${safeError(error)}\n` };
  }
  if (result.kind === "gate-pending") return pending(result.gate);
  return success(result.value, values.json === true);
}

/** Parse only documented production arguments, then delegate to the controller. */
export async function runCli(
  argv: readonly string[],
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  if (options.controller !== undefined)
    return await execute(options.controller, argv);
  let controller: CliController | undefined;
  try {
    controller = await openIngestionController();
    return await execute(controller, argv);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${safeError(error)}\n` };
  } finally {
    await controller?.dispose?.().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout !== "") stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  await main();
}
