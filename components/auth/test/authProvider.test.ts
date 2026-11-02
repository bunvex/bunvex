// `bunvexAuthProvider` (STUDY-201 §3.4), upstream's `server/authProvider.test.ts` ported: the cloud URL is
// `BUNVEX_CLOUD_URL` (DV-179), the audience `bunvex` (DV-576).
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
      applicationID: "bunvex",
      issuer: "https://happy-otter-123.bunvex.example/components/auth",
      jwks: "https://happy-otter-123.bunvex.example/.well-known/jwks.json",
      algorithm: "ES256",
    });
  });

  test("names the component the app mounts the auth component under", () => {
    process.env.BUNVEX_CLOUD_URL = "https://happy-otter-123.bunvex.example";
    expect(bunvexAuthProvider({ componentName: "myAuth" })).toMatchObject({
      issuer: "https://happy-otter-123.bunvex.example/components/myAuth",
      jwks: "https://happy-otter-123.bunvex.example/.well-known/jwks.json",
    });
  });

  test("throws without BUNVEX_CLOUD_URL", () => {
    process.env.BUNVEX_CLOUD_URL = "";
    expect(() => bunvexAuthProvider()).toThrow(
      "bunvexAuthProvider: the BUNVEX_CLOUD_URL environment variable is not set",
    );
  });
});
