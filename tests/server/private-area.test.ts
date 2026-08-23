import assert from "node:assert/strict";
import test from "node:test";

import {
  readAccessEnv,
  resolvePrivateAccess,
  signInPath,
  signOutPath,
} from "../../src/lib/auth/private-area.ts";

const identity = {
  displayName: "Persona Solar",
  email: "Persona@Example.com",
  fullName: "Persona Solar",
};

test("keeps only origin-local non-reserved return paths for sign-in and sign-out", () => {
  assert.equal(signInPath("//evil.test"), "/signin-with-chatgpt?return_to=%2F");
  assert.equal(
    signInPath("/\\evil.test/private"),
    "/signin-with-chatgpt?return_to=%2F",
  );
  assert.equal(
    signInPath("https://evil.test/private"),
    "/signin-with-chatgpt?return_to=%2F",
  );
  assert.equal(
    signInPath("/signin-with-chatgpt"),
    "/signin-with-chatgpt?return_to=%2F",
  );
  assert.equal(
    signInPath("/signout-with-chatgpt"),
    "/signin-with-chatgpt?return_to=%2F",
  );
  assert.equal(signInPath("/callback"), "/signin-with-chatgpt?return_to=%2F");
  assert.equal(
    signInPath("/guia-equipo?section=intro#first"),
    "/signin-with-chatgpt?return_to=%2Fguia-equipo%3Fsection%3Dintro%23first",
  );
  assert.equal(signOutPath(), "/signout-with-chatgpt?return_to=%2F");
  assert.equal(
    signOutPath("/socios#documentos"),
    "/signout-with-chatgpt?return_to=%2Fsocios%23documentos",
  );
});

test("fails closed for an absent identity and an empty allowlist", () => {
  assert.deepEqual(resolvePrivateAccess("socios", null, {}), {
    state: "anonymous",
    allowed: false,
  });
  assert.deepEqual(resolvePrivateAccess("socios", identity, {}), {
    state: "unconfigured",
    allowed: false,
  });
  assert.deepEqual(
    resolvePrivateAccess("equipo", identity, { TEAM_ALLOWED_EMAILS: ",;\n" }),
    { state: "unconfigured", allowed: false },
  );
});

test("normalizes configured allowlists and distinguishes denied from allowed access", () => {
  assert.deepEqual(
    resolvePrivateAccess("socios", identity, {
      SOCIOS_ALLOWED_EMAILS: "other@example.com; persona@example.com\n",
    }),
    { state: "allowed", allowed: true },
  );
  assert.deepEqual(
    resolvePrivateAccess("equipo", identity, {
      TEAM_ALLOWED_EMAILS: "other@example.com",
    }),
    { state: "denied", allowed: false },
  );
  assert.deepEqual(
    resolvePrivateAccess("manganafer", identity, {
      MANGANAFER_ALLOWED_EMAILS: "PERSONA@EXAMPLE.COM",
    }),
    { state: "allowed", allowed: true },
  );
});

test("reads only string allowlist bindings from an explicit Worker environment", () => {
  assert.deepEqual(
    readAccessEnv({
      TEAM_ALLOWED_EMAILS: "equipo@comunidadsolar.es",
      SOCIOS_ALLOWED_EMAILS: 42,
      MANGANAFER_ALLOWED_EMAILS: null,
      unrelated: "not-an-access-binding",
    }),
    { TEAM_ALLOWED_EMAILS: "equipo@comunidadsolar.es" },
  );
});
