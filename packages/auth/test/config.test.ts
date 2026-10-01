// The auth config's validation, with Convex's messages (STUDY-27 §1.1).
import { expect, test } from "bun:test";
import { parseAuthConfig } from "../src/index.ts";

const error = (config: unknown) => {
  try {
    parseAuthConfig(config);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  return null;
};

test("valid providers, normalized", () => {
  expect(
    parseAuthConfig({
      providers: [
        { domain: "clerk.example.com", applicationID: "convex" },
        { type: "oidc", domain: "https://auth.example.com/", applicationID: "a" },
        {
          type: "customJwt",
          issuer: "https://issuer.example.com",
          jwks: "https://issuer.example.com/jwks",
          algorithm: "RS256",
        },
      ],
    }),
  ).toEqual([
    { kind: "oidc", applicationId: "convex", domain: "https://clerk.example.com" },
    { kind: "oidc", applicationId: "a", domain: "https://auth.example.com/" },
    {
      kind: "customJwt",
      issuer: "https://issuer.example.com",
      jwks: "https://issuer.example.com/jwks",
      algorithm: "RS256",
    },
  ]);
});

test("Convex's checks and messages", () => {
  expect(error(undefined)).toEqual({
    code: "AuthConfigMissingExportError",
    message: "auth config file is missing default export.",
  });
  expect(error({ providers: [{ domain: "a.com", applicationId: "x" }] })?.message).toBe(
    "auth config file must include a list of provider credentials: Provider at index 0 must have applicationID property spelled lowercase 'application', capital I, capital D.",
  );
  expect(error({ providers: [{ type: "saml", domain: "a.com", applicationID: "x" }] })?.message).toContain(
    "Provider at index 0 has unexpected 'type' value 'saml'",
  );
  expect(
    error({ providers: [{ type: "customJwt", domain: "a.com", issuer: "a.com", jwks: "x", algorithm: "RS256" }] })
      ?.message,
  ).toContain("Provider at index 0 is a customJwt so cannot have a 'domain' specified");
  expect(error({ providers: [{ domain: "a.com", issuer: "a.com", applicationID: "x" }] })?.message).toContain(
    "Provider at index 0 is oidc so cannot have an 'issuer' specified.",
  );
  expect(
    error({ providers: [{ type: "customJwt", issuer: "https://api.workos.com/", jwks: "x", algorithm: "RS256" }] })
      ?.code,
  ).toBe("InsecureConfiguration");
  expect(error({ providers: [{ type: "customJwt", issuer: "a.com", jwks: "x", algorithm: "HS256" }] })).toEqual({
    code: "InvalidSignatureAlgorithm",
    message: 'Invalid signature algorithm (only RS256 and ES256 are supported): "HS256"',
  });
  expect(error({ providers: [{ domain: "not a url", applicationID: "x" }] })?.code).toBe("InvalidProviderDomainUrl");
  expect(error({ providers: [{ domain: "token123", applicationID: "x" }] })?.message).toBe(
    'Invalid provider domain URL "token123": Does not look like a URL (must have a scheme or end with a top-level domain)',
  );
});
