import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

const configPath = process.env.CLOUDFLARE_CONFIG_PATH;

export default defineConfig({
  site: "https://comunidadsolar.es",
  output: "server",
  trailingSlash: "never",
  build: { format: "file" },
  adapter: cloudflare({
    ...(configPath ? { configPath } : {}),
    imageService: { build: "compile", runtime: "cloudflare-binding" },
  }),
  integrations: [react()],
  vite: { resolve: { dedupe: ["react", "react-dom"] } },
});
