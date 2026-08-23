import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { join } from "node:path";

const fixtureCacheDirectory = process.env.MANGANAFER_ADMIN_FIXTURE_CACHE_DIR;

export default defineConfig({
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [react()],
  ...(fixtureCacheDirectory
    ? { cacheDir: join(fixtureCacheDirectory, "astro") }
    : {}),
  vite: {
    ...(fixtureCacheDirectory
      ? { cacheDir: join(fixtureCacheDirectory, "vite") }
      : {}),
    resolve: { dedupe: ["react", "react-dom"] },
  },
});
