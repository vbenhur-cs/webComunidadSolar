import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

import { readIdentity } from "../../../lib/auth/identity.ts";
import { readAccessEnv } from "../../../lib/auth/private-area.ts";
import { listManganaferInterests } from "../../../lib/db/client.ts";
import { ensureManganaferInterestStorage } from "../../../lib/db/migrations.ts";
import { handleManganaferInterestExport } from "../../../lib/manganafer/csv.ts";

export const prerender = false;

export function GET({ request }: APIContext): Promise<Response> {
  return handleManganaferInterestExport({
    identity: readIdentity(request.headers),
    env: readAccessEnv(env as unknown as Record<string, unknown>),
    async listInterests() {
      await ensureManganaferInterestStorage(env.DB);
      return listManganaferInterests(env.DB);
    },
  });
}
