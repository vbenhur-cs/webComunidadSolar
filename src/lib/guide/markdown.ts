import type { Identity } from "../auth/identity.ts";
import {
  resolvePrivateAccess,
  signInPath,
  type AccessEnv,
} from "../auth/private-area.ts";
import { hydrateTeamGuideMarkdown, teamGuideDownloadPath } from "./runtime.ts";

export type GuideBlock =
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; language: string; value: string }
  | { kind: "rule" };

export type GuideInline =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string; href: string; external: boolean };

export interface TeamGuideMarkdownResponseInput {
  request: Request;
  identity: Identity | null;
  env: AccessEnv;
  source: string;
}

export function slugifyGuideHeading(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isTableDivider(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function readTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isStructuralLine(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return (
    !line ||
    /^#{1,4}\s+/.test(line) ||
    /^```/.test(line) ||
    /^>\s?/.test(line) ||
    /^---+$/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    (line.startsWith("|") && isTableDivider(next))
  );
}

export function parseGuideMarkdown(source: string): GuideBlock[] {
  const lines = source.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const body = firstSection >= 0 ? lines.slice(firstSection) : lines;
  const blocks: GuideBlock[] = [];
  let index = 0;

  while (index < body.length) {
    const raw = body[index];
    const line = raw.trim();

    if (!line) {
      index += 1;
      continue;
    }

    if (/^---+$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
        id: slugifyGuideHeading(heading[2]),
      });
      index += 1;
      continue;
    }

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const values: string[] = [];
      index += 1;
      while (index < body.length && !/^```/.test(body[index].trim())) {
        values.push(body[index]);
        index += 1;
      }
      index += 1;
      blocks.push({
        kind: "code",
        language: fence[1].trim(),
        value: values.join("\n"),
      });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const values: string[] = [];
      while (index < body.length && /^>\s?/.test(body[index].trim())) {
        values.push(body[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: values.join(" ") });
      continue;
    }

    if (line.startsWith("|") && isTableDivider(body[index + 1]?.trim() ?? "")) {
      const headers = readTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < body.length && body[index].trim().startsWith("|")) {
        rows.push(readTableRow(body[index].trim()));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      const pattern = orderedList ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
      while (index < body.length) {
        const item = body[index].trim().match(pattern);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ kind: "list", ordered: orderedList, items });
      continue;
    }

    const values = [line];
    index += 1;
    while (index < body.length && !isStructuralLine(body, index)) {
      values.push(body[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: values.join(" ") });
  }

  return blocks;
}

export function parseGuideInline(value: string): GuideInline[] {
  const tokens = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  return value
    .split(tokens)
    .filter(Boolean)
    .map((part): GuideInline => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return { kind: "strong", value: part.slice(2, -2) };
      }

      if (part.startsWith("`") && part.endsWith("`")) {
        return { kind: "code", value: part.slice(1, -1) };
      }

      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        return {
          kind: "link",
          value: link[1],
          href: link[2],
          external: /^https?:\/\//.test(link[2]),
        };
      }

      return { kind: "text", value: part };
    });
}

export function teamGuideMarkdownResponse({
  request,
  identity,
  env,
  source,
}: TeamGuideMarkdownResponseInput): Response {
  if (!identity) {
    return Response.redirect(
      new URL(signInPath(teamGuideDownloadPath), request.url),
      307,
    );
  }

  const decision = resolvePrivateAccess("equipo", identity, env);
  if (!decision.allowed) {
    return new Response("Cuenta no autorizada.", {
      status: 403,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }

  return new Response(hydrateTeamGuideMarkdown(source), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="guia-equipo-nueva-web-comunidad-solar.md"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
