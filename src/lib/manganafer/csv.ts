import type { Identity } from "../auth/identity.ts";
import { resolvePrivateAccess, type AccessEnv } from "../auth/private-area.ts";

export interface ManganaferInterestExportRow {
  id: number;
  createdAt: string;
  kind: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  municipality: string;
  postalCode: string;
  address: string;
  participantProfile: string;
  roofSurfaceRange: string;
  roofRelationship: string;
  message: string;
  status: string;
  consentVersion: string;
}

export interface ManganaferInterestExportInput {
  identity: Identity | null;
  env: AccessEnv;
  listInterests(): Promise<readonly ManganaferInterestExportRow[]>;
  now?: () => Date;
}

const csvColumns = [
  ["createdAt", "Fecha"],
  ["kind", "Tipo"],
  ["firstName", "Nombre"],
  ["lastName", "Apellidos"],
  ["email", "Email"],
  ["phone", "Teléfono"],
  ["municipality", "Municipio o diputación"],
  ["postalCode", "Código postal"],
  ["address", "Dirección o zona"],
  ["participantProfile", "Perfil participante"],
  ["roofSurfaceRange", "Superficie cubierta"],
  ["roofRelationship", "Relación con cubierta"],
  ["message", "Mensaje"],
  ["status", "Estado"],
  ["consentVersion", "Consentimiento"],
] as const satisfies ReadonlyArray<
  readonly [keyof ManganaferInterestExportRow, string]
>;

function csvCell(value: unknown): string {
  const stringValue = value == null ? "" : String(value);
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export function toInterestCsv(
  rows: readonly ManganaferInterestExportRow[],
): string {
  const csv = [
    csvColumns.map(([, label]) => csvCell(label)).join(","),
    ...rows.map((row) =>
      csvColumns.map(([key]) => csvCell(row[key])).join(","),
    ),
  ].join("\r\n");
  return `\uFEFF${csv}`;
}

export async function handleManganaferInterestExport({
  identity,
  env,
  listInterests,
  now = () => new Date(),
}: ManganaferInterestExportInput): Promise<Response> {
  if (!identity) {
    return Response.json(
      { error: "Necesitas identificarte." },
      { status: 401 },
    );
  }

  if (!resolvePrivateAccess("manganafer", identity, env).allowed) {
    return Response.json({ error: "Acceso no autorizado." }, { status: 403 });
  }

  const date = now().toISOString().slice(0, 10);
  return new Response(toInterestCsv(await listInterests()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="manganafer-interesados-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
