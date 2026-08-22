import { handle } from "@astrojs/cloudflare/handler";

import { runWorkerResponsePipeline } from "./lib/http/response-policy";

export default {
  async fetch(request, env, ctx) {
    return runWorkerResponsePipeline(request, () => handle(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
