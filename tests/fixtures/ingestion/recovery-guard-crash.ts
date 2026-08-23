import { writeFile } from "node:fs/promises";

import { createStateStore } from "../../../src/ingest/state-store.ts";

const [stateRoot, markerPath, createdAt] = process.argv.slice(2);

if (
  stateRoot === undefined ||
  markerPath === undefined ||
  createdAt === undefined
) {
  throw new Error("El fixture de crash no recibió sus argumentos");
}

const store = createStateStore({
  stateRoot,
  now: () => new Date(createdAt),
  testHooks: {
    afterRecoveryGuardAcquired: async () => {
      await writeFile(markerPath, "acquired", { flag: "wx" });
      process.exit(0);
    },
  },
});

await store.withChangeLock("landing-solar", async () => {
  throw new Error("El fixture debía salir antes del callback");
});
