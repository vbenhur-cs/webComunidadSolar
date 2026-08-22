import assert from "node:assert/strict";
import test from "node:test";

import { readIdentity } from "../../src/lib/auth/identity.ts";

test("decodes a percent-encoded UTF-8 full name from explicit identity headers", () => {
  const identity = readIdentity(
    new Headers({
      "oai-authenticated-user-email": "Persona@Example.com",
      "oai-authenticated-user-full-name": "V%C3%ADctor%20Solar",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    }),
  );

  assert.deepEqual(identity, {
    displayName: "Víctor Solar",
    email: "Persona@Example.com",
    fullName: "Víctor Solar",
  });
});

test("fails closed when an identity email header is absent", () => {
  assert.equal(readIdentity(new Headers()), null);
});

test("does not trust an undecodable or differently encoded full name", () => {
  const malformed = readIdentity(
    new Headers({
      "oai-authenticated-user-email": "persona@example.com",
      "oai-authenticated-user-full-name": "%E0%A4",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    }),
  );
  const plain = readIdentity(
    new Headers({
      "oai-authenticated-user-email": "persona@example.com",
      "oai-authenticated-user-full-name": "Víctor Solar",
      "oai-authenticated-user-full-name-encoding": "plain-utf-8",
    }),
  );

  assert.deepEqual(malformed, {
    displayName: "persona@example.com",
    email: "persona@example.com",
    fullName: null,
  });
  assert.deepEqual(plain, malformed);
});
