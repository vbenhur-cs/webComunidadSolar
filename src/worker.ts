import { handle } from "@astrojs/cloudflare/handler";

import { routeBeforeAstro } from "./lib/routing/before-astro";
import { normalizeWorkerResponse } from "./lib/routing/response-headers";

export default {
  async fetch(request, env, ctx) {
    const routed = routeBeforeAstro(request);
    if (routed) return routed;

    return normalizeWorkerResponse(request, await handle(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
