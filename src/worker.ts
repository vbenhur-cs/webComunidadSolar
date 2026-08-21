import { handle } from "@astrojs/cloudflare/handler";

import { routeBeforeAstro } from "./lib/routing/before-astro";

export default {
  fetch(request, env, ctx) {
    return routeBeforeAstro(request) ?? handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
