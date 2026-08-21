import { FetchState, astro } from "astro/fetch";

import { routeBeforeAstro } from "./lib/routing/before-astro";

export default {
  fetch(request) {
    return routeBeforeAstro(request) ?? astro(new FetchState(request));
  },
} satisfies import("astro").Fetchable;
