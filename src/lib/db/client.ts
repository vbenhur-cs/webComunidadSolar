import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { manganaferInterests } from "./schema.ts";
import type {
  InterestKind,
  ManganaferInterest,
} from "../manganafer/interest.ts";

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
