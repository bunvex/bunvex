// `bunvexAuthProvider` (STUDY-201 §3.4, STUDY-208 §1.8), upstream's `server/authProvider.test.ts` at v2.0.0 ported: the
// cloud URL is `BUNVEX_CLOUD_URL` (DV-179), the audience `bunvex-auth` (DV-576).
import { afterEach, describe, expect, test } from "bun:test";
import { bunvexAuthProvider } from "../src/server/authProvider.ts";

const saved = process.env.BUNVEX_CLOUD_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.BUNVEX_CLOUD_URL;
  else process.env.BUNVEX_CLOUD_URL = saved;
});

describe("bunvexAuthProvider", () => {
  test("trusts the tokens the auth component mints", () => {
    process.env.BUNVEX_CLOUD_URL = "https://happy-otter-123.bunvex.example";
    expect(bunvexAuthProvider()).toEqual({
      type: "customJwt",
      applicationID: "bunvex-auth",
      issuer: "https://happy-otter-123.bunvex.example/components/auth",
      jwks: "https://happy-otter-123.bunvex.example/.well-known/jwks.json",
      algorithm: "ES256",
    });
  });

  test("throws without BUNVEX_CLOUD_URL", () => {
    process.env.BUNVEX_CLOUD_URL = "";
    expect(() => bunvexAuthProvider()).toThrow(
      "bunvexAuthProvider: the BUNVEX_CLOUD_URL environment variable is not set",
    );
  });
});
