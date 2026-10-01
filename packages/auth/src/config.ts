// The auth config (STUDY-27 §1.1): `{ providers }`, each OIDC (`{ domain, applicationID }`) or a custom JWT
// (`{ type: "customJwt", issuer, jwks, algorithm, applicationID? }`), with the checks and messages of Convex's
// crates/isolate/src/environment/auth_config.rs and crates/common/src/auth.rs (naming bunvex's file).
import { badRequest } from "./errors.ts";

export type AuthProvider =
  | { type?: "oidc"; applicationID: string; domain: string }
  | { type: "customJwt"; applicationID?: string; issuer: string; jwks: string; algorithm: "RS256" | "ES256" };

export type AuthConfig = { providers: AuthProvider[] };

/** A validated provider; `domain` / `issuer` are normalized URLs (https:// added when missing). */
export type AuthInfo =
  | { kind: "oidc"; applicationId: string; domain: string }
  | { kind: "customJwt"; applicationId?: string; issuer: string; jwks: string; algorithm: "RS256" | "ES256" };

/** Where an app keeps its config (named in messages, as Convex names `convex/auth.config.ts`). */
export const AUTH_CONFIG_FILE = "bunvex/auth.config.ts";

const schemaError = (detail: string) =>
  badRequest(
    "AuthConfigNotMatchingSchemaError",
    `auth config file must include a list of provider credentials: ${detail}`,
  );

/** Convex's `ends_with_tld`, approximated: `localhost`, or a last label of letters (a real TLD list is overkill). */
const endsWithTld = (host: string) => host === "localhost" || /\.[a-z]{2,}$/i.test(host);

/** Convex's `deserialize_issuer_url`: an http(s) URL, `https://` added when there is no scheme. */
export function normalizeIssuerUrl(original: string): string {
  const invalid = (why: string) =>
    badRequest("InvalidProviderDomainUrl", `Invalid provider domain URL "${original}": ${why}`);
  if (original.startsWith('"')) throw invalid('starts with a double quote (")');
  const hadScheme = /^\w+:\/\//.test(original);
  const url = hadScheme ? original : `https://${original}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid("scheme should be http or https");
  if (!hadScheme && !endsWithTld(parsed.hostname))
    throw invalid("Does not look like a URL (must have a scheme or end with a top-level domain)");
  return url;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Validate a config (the default export of `bunvex/auth.config.ts`) into the providers tokens are checked against. */
export function parseAuthConfig(config: unknown): AuthInfo[] {
  if (config === undefined || config === null)
    throw badRequest("AuthConfigMissingExportError", "auth config file is missing default export.");
  if (!isObject(config)) throw schemaError("expected an object with `providers`");
  const providers = config.providers;
  if (!Array.isArray(providers)) throw schemaError("missing field `providers`");
  // Convex's `check_for_common_confusions`, before the schema itself.
  providers.forEach((p, index) => {
    if (!isObject(p)) return;
    const type = typeof p.type === "string" ? p.type : "unknown";
    if ("applicationId" in p || "applicationid" in p)
      throw schemaError(
        `Provider at index ${index} must have applicationID property spelled lowercase 'application', capital I, capital D.`,
      );
    if (type !== "customJwt" && type !== "oidc" && type !== "unknown")
      throw schemaError(`Provider at index ${index} has unexpected 'type' value '${type}'`);
    if (type === "customJwt" && "domain" in p)
      throw schemaError(`Provider at index ${index} is a customJwt so cannot have a 'domain' specified`);
    if ((type === "oidc" || type === "unknown") && "issuer" in p)
      throw schemaError(`Provider at index ${index} is oidc so cannot have an 'issuer' specified.`);
    if (!("applicationID" in p) && (p.issuer === "https://api.workos.com/" || p.issuer === "https://api.workos.com"))
      throw badRequest(
        "InsecureConfiguration",
        `This auth configuration appears potentially insecure: Provider at index ${index} has an issuer that is shared among many applications, so must to specify an ApplicationID to check against an \`aud\` field of a JWT.`,
      );
  });
  return providers.map((p, index): AuthInfo => {
    if (!isObject(p)) throw schemaError(`provider at index ${index} is not an object`);
    const str = (field: string, optional = false) => {
      const v = p[field];
      if (v === undefined && optional) return undefined;
      if (typeof v !== "string") throw schemaError(`provider at index ${index}: \`${field}\` must be a string`);
      return v;
    };
    if (p.type === "customJwt") {
      const algorithm = str("algorithm");
      if (algorithm !== "RS256" && algorithm !== "ES256")
        throw badRequest(
          "InvalidSignatureAlgorithm",
          `Invalid signature algorithm (only RS256 and ES256 are supported): ${JSON.stringify(algorithm)}`,
        );
      const applicationId = str("applicationID", true);
      return {
        kind: "customJwt",
        ...(applicationId === undefined ? {} : { applicationId }),
        issuer: normalizeIssuerUrl(str("issuer")!),
        jwks: str("jwks")!,
        algorithm,
      };
    }
    return { kind: "oidc", applicationId: str("applicationID")!, domain: normalizeIssuerUrl(str("domain")!) };
  });
}
