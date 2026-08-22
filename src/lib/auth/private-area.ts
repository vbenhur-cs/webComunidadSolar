import type { Identity } from "./identity";

export type PrivateArea = "socios" | "equipo" | "manganafer";

export interface AccessEnv {
  SOCIOS_ALLOWED_EMAILS?: string;
  TEAM_ALLOWED_EMAILS?: string;
  MANGANAFER_ALLOWED_EMAILS?: string;
}

export type PrivateAccessDecision =
  | { state: "allowed"; allowed: true }
  | {
      state: "anonymous" | "denied" | "unconfigured";
      allowed: false;
    };

const accessVariables: Record<PrivateArea, keyof AccessEnv> = {
  socios: "SOCIOS_ALLOWED_EMAILS",
  equipo: "TEAM_ALLOWED_EMAILS",
  manganafer: "MANGANAFER_ALLOWED_EMAILS",
};

const signInRoute = "/signin-with-chatgpt";
const signOutRoute = "/signout-with-chatgpt";
const callbackRoute = "/callback";

export function signInPath(returnTo: string): string {
  return `${signInRoute}?return_to=${encodeURIComponent(
    safeRelativeReturnPath(returnTo),
  )}`;
}

export function signOutPath(returnTo = "/"): string {
  return `${signOutRoute}?return_to=${encodeURIComponent(
    safeRelativeReturnPath(returnTo),
  )}`;
}

export function resolvePrivateAccess(
  area: PrivateArea,
  identity: Identity | null,
  env: AccessEnv,
): PrivateAccessDecision {
  if (!identity) return { state: "anonymous", allowed: false };

  const allowedEmails = configuredEmails(area, env);
  if (allowedEmails.size === 0) {
    return { state: "unconfigured", allowed: false };
  }

  return allowedEmails.has(normalizeEmail(identity.email))
    ? { state: "allowed", allowed: true }
    : { state: "denied", allowed: false };
}

function configuredEmails(area: PrivateArea, env: AccessEnv): Set<string> {
  const value = env[accessVariables[area]] ?? "";
  return new Set(
    value
      .split(/[,;\n]/)
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }

  if (url.origin !== "https://app.local" || isReservedAuthPath(url.pathname)) {
    return "/";
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === signInRoute ||
    pathname === signOutRoute ||
    pathname === callbackRoute
  );
}
