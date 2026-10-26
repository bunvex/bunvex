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

// Convex's `ends_with_tld` (crates/common/src/auth.rs): without a scheme, the host must be `localhost` or end with
// one of IANA's top-level domains (STUDY-188 R4, measured on Convex's binary).
const domainOf = (domain: string) => {
  const [info] = parseAuthConfig({ providers: [{ domain, applicationID: "123" }] });
  return info!.kind === "oidc" ? info!.domain : null;
};
const notAUrl = (domain: string) =>
  `Invalid provider domain URL "${domain}": Does not look like a URL (must have a scheme or end with a top-level domain)`;

test("a domain without a scheme ends with a top-level domain (Convex: test_auth_info_rejects_bogus_domain)", () => {
  for (const domain of ["foobar123", "idont.looklikeadomain", "example.local", "example.internal", "foo.test"])
    expect({ domain, error: error({ providers: [{ domain, applicationID: "123" }] }) }).toEqual({
      domain,
      error: { code: "InvalidProviderDomainUrl", message: notAUrl(domain) },
    });
  // Neither an address nor a host ending with a dot has a top-level domain as its last label.
  for (const domain of ["127.0.0.1", "foo.com.", "com"])
    expect(error({ providers: [{ domain, applicationID: "123" }] })?.message).toBe(notAUrl(domain));
});

test("an internationalized top-level domain, and case, as the parsed host has them", () => {
  expect(domainOf("foo.xn--p1ai")).toBe("https://foo.xn--p1ai");
  expect(error({ providers: [{ domain: "foo.рф", applicationID: "123" }] })).toBeNull();
  expect(domainOf("EXAMPLE.COM")).toBe("https://EXAMPLE.COM");
  expect(domainOf("auth.example.io")).toBe("https://auth.example.io");
});

test("https:// added when there is no scheme (Convex: test_auth_info_https_prefix)", () => {
  expect(domainOf("example.com")).toBe("https://example.com");
  expect(domainOf("localhost")).toBe("https://localhost");
});

test("a scheme skips the check (Convex: test_auth_info_http_localhost)", () => {
  expect(domainOf("http://localhost:3211")).toBe("http://localhost:3211");
  expect(domainOf("http://127.0.0.1:3211")).toBe("http://127.0.0.1:3211");
  expect(domainOf("https://idont.looklikeadomain")).toBe("https://idont.looklikeadomain");
});

test("only http and https (Convex: test_auth_info_file_fails)", () => {
  expect(error({ providers: [{ domain: "file://example.com", applicationID: "123" }] })).toEqual({
    code: "InvalidProviderDomainUrl",
    message: 'Invalid provider domain URL "file://example.com": scheme should be http or https',
  });
});
