// The contract suite's part for authentication providers (UI-01 §19.1, data-source-auth.ts): checked whenever
// the source offers the method — reading is harmless.
import { expect } from "bun:test";
import type { AuthProvider, DashboardDataSource } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
};

const isString = (v: unknown) => typeof v === "string" && v !== "";

/** A provider as Convex describes it: OIDC (domain, applicationID) or custom JWT (issuer, jwks, algorithm). */
export function isAuthProvider(p: AuthProvider): boolean {
  if (p.type === "customJwt")
    return (
      isString(p.issuer) &&
      isString(p.jwks) &&
      (p.algorithm === "RS256" || p.algorithm === "ES256") &&
      (p.applicationID === undefined || isString(p.applicationID))
    );
  return p.type === undefined && isString(p.domain) && isString(p.applicationID);
}

export function describeAuthContract({ make, test }: Ctx) {
  test("auth providers (when offered): a list of OIDC or custom JWT providers", async () => {
    const src = await make();
    if (!src.listAuthProviders) return;
    const caps = await src.getCapabilities();
    if (!caps.operations.includes("viewData") || !caps.operations.includes("viewEnvironmentVariables")) return;
    const providers = await src.listAuthProviders();
    expect(Array.isArray(providers)).toBe(true);
    for (const p of providers) expect(isAuthProvider(p)).toBe(true);
  });
}
