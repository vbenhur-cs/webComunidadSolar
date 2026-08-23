import migrationSql from "../../../drizzle/0000_fat_wolfsbane.sql?raw";

const migrationStatements = migrationSql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const storageReady = new WeakMap<object, Promise<void>>();

export function manganaferInterestMigrationStatements(): readonly string[] {
  return migrationStatements;
}

/**
 * Applies the single checked-in migration only for an uninitialised local D1
 * binding. Production deployment owns migration application; this guard keeps
 * the route safe for isolated local Workers without duplicating DDL in code.
 */
export async function ensureManganaferInterestStorage(
  database: D1Database,
): Promise<void> {
  const existing = storageReady.get(database);
  if (existing) return existing;

  const ready = (async () => {
    const table = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manganafer_interests'",
      )
      .first<{ name: string }>();
    if (table !== null) return;
    await database.batch(
      migrationStatements.map((statement) => database.prepare(statement)),
    );
  })();
  storageReady.set(database, ready);
  try {
    await ready;
  } catch (error) {
    storageReady.delete(database);
    throw error;
  }
}
