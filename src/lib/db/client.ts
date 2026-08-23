import { desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { manganaferInterests } from "./schema.ts";
import type {
  InterestKind,
  ManganaferInterest,
} from "../manganafer/interest.ts";
import type { ManganaferInterestExportRow } from "../manganafer/csv.ts";

export function createDatabase(database: D1Database) {
  return drizzle(database, { schema: { manganaferInterests } });
}

export async function persistManganaferInterest(
  database: D1Database,
  interest: ManganaferInterest,
): Promise<{ id: number; kind: InterestKind }> {
  const db = createDatabase(database);
  const [saved] = await db
    .insert(manganaferInterests)
    .values(interest)
    .onConflictDoUpdate({
      target: [manganaferInterests.email, manganaferInterests.kind],
      set: {
        firstName: interest.firstName,
        lastName: interest.lastName,
        phone: interest.phone,
        municipality: interest.municipality,
        postalCode: interest.postalCode,
        address: interest.address,
        participantProfile: interest.participantProfile,
        roofSurfaceRange: interest.roofSurfaceRange,
        roofRelationship: interest.roofRelationship,
        message: interest.message,
        consentVersion: interest.consentVersion,
        status: interest.status,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({
      id: manganaferInterests.id,
      kind: manganaferInterests.kind,
    });

  if (saved === undefined) {
    throw new Error("Manganafer interest persistence did not return a row");
  }
  return saved as { id: number; kind: InterestKind };
}

/** Lists the private Manganáfer register in the source-defined stable order. */
export async function listManganaferInterests(
  database: D1Database,
): Promise<ManganaferInterestExportRow[]> {
  const db = createDatabase(database);
  return db
    .select({
      id: manganaferInterests.id,
      createdAt: manganaferInterests.createdAt,
      kind: manganaferInterests.kind,
      firstName: manganaferInterests.firstName,
      lastName: manganaferInterests.lastName,
      email: manganaferInterests.email,
      phone: manganaferInterests.phone,
      municipality: manganaferInterests.municipality,
      postalCode: manganaferInterests.postalCode,
      address: manganaferInterests.address,
      participantProfile: manganaferInterests.participantProfile,
      roofSurfaceRange: manganaferInterests.roofSurfaceRange,
      roofRelationship: manganaferInterests.roofRelationship,
      message: manganaferInterests.message,
      status: manganaferInterests.status,
      consentVersion: manganaferInterests.consentVersion,
    })
    .from(manganaferInterests)
    .orderBy(desc(manganaferInterests.createdAt), desc(manganaferInterests.id));
}
