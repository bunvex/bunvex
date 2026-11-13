// The core mounted only as `auth` (STUDY-208 §1.8), upstream's `lib/coreComponent.test.ts` at v2.0.0, ported: the cloud
// URL is `BUNVEX_CLOUD_URL` (DV-179), set for the test's process as upstream's vitest config sets Convex's. The
// end-to-end checks (a core mounted under another name, the cloud URL inside a component) are in `methods.test.ts`
// and `deployment.test.ts`.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api and the inline function's ctx are untyped
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest } from "@bunvex/testing";
import { assertMountedAsCore, componentPathFromIssuer } from "../src/lib/coreComponent.ts";

const CLOUD_URL = "https://some-deployment.bunvex.example";
const saved = process.env.BUNVEX_CLOUD_URL;
beforeEach(() => {
  process.env.BUNVEX_CLOUD_URL = CLOUD_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BUNVEX_CLOUD_URL;
  else process.env.BUNVEX_CLOUD_URL = saved;
});
setDefaultTimeout(60_000);

/** A JWT with the given issuer. Its signature is not valid: `assertMountedAsCore` reads the issuer and checks no signature. */
function tokenWithIssuer(issuer: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: issuer, aud: "test" })}.signature`;
}

describe("assertMountedAsCore", () => {
  test("accepts a token that the core signed at `auth`", () => {
    expect(() => assertMountedAsCore(tokenWithIssuer(`${CLOUD_URL}/components/auth`))).not.toThrow();
  });

  test("throws for a core mounted at a different path", () => {
    expect(() => assertMountedAsCore(tokenWithIssuer(`${CLOUD_URL}/components/myAuth`))).toThrow(
      'The auth component is mounted at "myAuth", but it must be mounted at "auth". Use `app.use(auth)` in ' +
        "bunvex.config.ts, without a `name` option.",
    );
    // A nested mount is another path too.
    expect(() => assertMountedAsCore(tokenWithIssuer(`${CLOUD_URL}/components/parent/auth`))).toThrow(
      'mounted at "parent/auth"',
    );
  });

  test("accepts a token that the app signed, as in tests of the core", async () => {
    const t = bunvexTest({ cwd: join(import.meta.dir, "fixtures", "standalone") });
    try {
      const token = await t.run(
        async (ctx: any) => await ctx.auth.signJwt({ claims: { aud: "test" }, expiresInSeconds: 1 }),
      );
      process.env.BUNVEX_CLOUD_URL = (await t.query((anyApi as any).testApp.cloudUrl, {})) as string;
      expect(() => assertMountedAsCore(token)).not.toThrow();
    } finally {
      await t.close();
    }
  });

  // Beyond upstream: the message when the variable is missing, with bunvex's name for it.
  test("throws without BUNVEX_CLOUD_URL", () => {
    process.env.BUNVEX_CLOUD_URL = "";
    expect(() => assertMountedAsCore(tokenWithIssuer(`${CLOUD_URL}/components/auth`))).toThrow(
      "The BUNVEX_CLOUD_URL environment variable is not set. The auth component needs it to check the issuer of a token.",
    );
  });
});

describe("componentPathFromIssuer", () => {
  test("returns the path of a component issuer", () => {
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/auth`)).toBe("auth");
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/parent/authPassword`)).toBe("parent/authPassword");
    // The cloud URL's trailing slash does not count.
    process.env.BUNVEX_CLOUD_URL = `${CLOUD_URL}//`;
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/auth`)).toBe("auth");
  });

  test("returns null for the app, another deployment, or no issuer", () => {
    expect(componentPathFromIssuer(CLOUD_URL)).toBeNull();
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/`)).toBeNull();
    expect(componentPathFromIssuer("https://other.bunvex.example/components/auth")).toBeNull();
    expect(componentPathFromIssuer(undefined)).toBeNull();
  });
});
