import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const manganaferInterests = sqliteTable(
  "manganafer_interests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["neighbor", "roof"] }).notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    municipality: text("municipality").notNull(),
    postalCode: text("postal_code").notNull(),
    address: text("address").notNull().default(""),
    participantProfile: text("participant_profile").notNull().default(""),
    roofSurfaceRange: text("roof_surface_range").notNull().default(""),
    roofRelationship: text("roof_relationship").notNull().default(""),
    message: text("message").notNull().default(""),
    consentVersion: text("consent_version").notNull().default("2026-07-31"),
    source: text("source").notNull().default("manganafer-landing"),
    status: text("status").notNull().default("nuevo"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("manganafer_interests_email_kind_unique").on(
      table.email,
      table.kind,
    ),
    index("manganafer_interests_created_at_idx").on(table.createdAt),
    index("manganafer_interests_kind_idx").on(table.kind),
  ],
);
