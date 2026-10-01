// Token verification (STUDY-27 §1.2), as Convex's crates/authentication/src/lib.rs `validate_id_token`:
// pick the provider from the token's unverified `iss` / `aud`, then verify it the provider's way.
// - OIDC: OpenID Connect discovery on the issuer, the provider's JWKS, RS256 or EdDSA, `iss` and `aud` exact,
//   not expired.
// - Custom JWT: the configured JWKS (a URL or a `data:` URL), the configured algorithm and the token's `kid`,
//   then `iss`, `aud`, and the time claims with 5 s of leeway.
// Discovery and JWKS responses are cached by `Cache-Control`; a token naming an unknown `kid` refetches the
// JWKS (at most every 30 s), so a key rotation takes effect at once (STUDY-27 A3, DV-101).
import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import type { AuthInfo } from "./config.ts";
import { AuthenticationError, badRequest, unauthenticated } from "./errors.ts";
import { identityFromCustomJwt, identityFromOidc, type VerifiedIdentity } from "./identity.ts";

/** Leeway on a custom JWT's time claims (Convex's `epsilon: chrono::Duration::seconds(5)`). */
const CUSTOM_JWT_LEEWAY_S = 5;
/** A JWKS is refetched for an unknown `kid` at most this often. */
const UNKNOWN_KID_REFETCH_MS = 30_000;
const JWKS_MEDIA_TYPES = ["application/json", "application/jwk-set+json"];

export type VerifierOptions = {
  /** Replace `fetch` (tests use an in-process issuer). */
  fetch?: typeof fetch;
  /** The clock, in ms (tests). */
  now?: () => number;
  /** Omit details from errors (the server's `redactLogsToClient`): the provider list. */
  redactErrors?: boolean;
};

type CacheEntry = { body: unknown; expires: number; fetchedAt: number };

/** Seconds a response may be reused for, by its `Cache-Control` (or the usual 10%-of-age heuristic). */
function freshness(r: Response, now: number): number {
  const cc = r.headers.get("cache-control") ?? "";
  if (/\bno-store\b|\bno-cache\b/i.test(cc)) return 0;
  const m = /\b(?:s-maxage|max-age)\s*=\s*(\d+)/i.exec(cc);
  if (m) return Number(m[1]);
  const lastModified = Date.parse(r.headers.get("last-modified") ?? "");
  if (Number.isFinite(lastModified)) return Math.min(86_400, Math.max(0, (now - lastModified) / 10_000));
  return 0;
}

const withHttps = (iss: string) => (iss.startsWith("https://") || iss.startsWith("http://") ? iss : `https://${iss}`);
const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const audiences = (aud: unknown): string[] =>
  Array.isArray(aud) ? aud.map(String) : typeof aud === "string" ? [aud] : [];

/** Whether a provider takes a token with this issuer and these audiences (Convex's `AuthInfo::matches_token`). */
function matches(info: AuthInfo, auds: string[], issuer: string): boolean {
  const appId = info.applicationId;
  if (appId !== undefined && !auds.includes(appId)) return false;
  return sameIssuer(info.kind === "oidc" ? info.domain : info.issuer, withHttps(issuer));
}

export class TokenVerifier {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly providers: AuthInfo[],
    private readonly opts: VerifierOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** A token's identity, or an `AuthenticationError` saying what to check. */
  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: Record<string, unknown>;
    try {
      payload = decodeJwt(token);
    } catch {
      throw unauthenticated(
        "InvalidAuthHeader",
        "Could not parse JWT payload. Check that the token is a valid JWT format with three base64-encoded parts separated by dots.",
      );
    }
    if (typeof payload.iss !== "string")
      throw unauthenticated(
        "InvalidAuthHeader",
        "Missing issuer claim ('iss') in JWT payload. The JWT must include an 'iss' claim that matches one of your configured auth providers.",
      );
    const issuer = payload.iss;
    const info = this.providers.find((p) => matches(p, audiences(payload.aud), issuer));
    if (!info) throw unauthenticated("NoAuthProvider", this.noProviderMessage());
    return info.kind === "oidc" ? this.verifyOidc(token, info, issuer) : this.verifyCustom(token, info);
  }

  private noProviderMessage(): string {
    if (this.opts.redactErrors) return "No auth provider found matching the given token";
    if (this.providers.length === 0)
      return "No auth provider found matching the given token (no providers configured). Check bunvex/auth.config.ts.";
    const list = this.providers.map((p) =>
      p.kind === "oidc"
        ? `OIDC(domain=${p.domain}, app_id=${p.applicationId})`
        : `CustomJWT(issuer=${p.issuer}, app_id=${p.applicationId ?? "none"})`,
    );
    return `No auth provider found matching the given token. Check that your JWT's issuer and audience match one of your configured providers: [${list.join(", ")}]`;
  }

  /** GET a JSON document through the cache (`refresh`: bypass a fresh entry). */
  private async getJson(url: string, check: (r: Response) => Promise<void>, refresh = false): Promise<unknown> {
    const now = this.now();
    const hit = this.cache.get(url);
    if (hit && !refresh && hit.expires > now) return hit.body;
    const running = this.inflight.get(url);
    if (running) return running;
    const p = (async () => {
      const r = await this.fetchFn(url, { headers: { accept: "application/json" } });
      await check(r);
      const body = await r.json();
      const ttl = freshness(r, now);
      if (ttl > 0) this.cache.set(url, { body, expires: now + ttl * 1000, fetchedAt: now });
      else this.cache.delete(url);
      return body;
    })();
    this.inflight.set(url, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(url);
    }
  }

  private async discover(issuer: string): Promise<{ issuer: string; jwks_uri: string }> {
    const url = `${issuer}${issuer.endsWith("/") ? "" : "/"}.well-known/openid-configuration`;
    const failed = (detail: string) =>
      badRequest("AuthProviderDiscoveryFailed", `Auth provider discovery of ${issuer} failed${detail}`);
    let meta: { issuer?: unknown; jwks_uri?: unknown };
    try {
      meta = (await this.getJson(url, async (r) => {
        if (!r.ok) throw failed(`: ${r.status} ${await r.text()}`);
      })) as typeof meta;
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      throw failed("");
    }
    // OIDC discovery requires the document to name the same issuer.
    if (meta.issuer !== issuer || typeof meta.jwks_uri !== "string") throw failed("");
    return meta as { issuer: string; jwks_uri: string };
  }

  private async oidcJwks(jwksUri: string, refresh: boolean): Promise<JSONWebKeySet> {
    return (await this.getJson(
      jwksUri,
      async (r) => {
        if (!r.ok)
          throw badRequest("AuthProviderDiscoveryFailed", `Could not fetch the JWKS of ${jwksUri}: ${r.status}`);
      },
      refresh,
    )) as JSONWebKeySet;
  }

  /** Run `use` with a JWKS; on a `kid` the set lacks, refetch it once (rate-limited) and retry. */
  private async withKeys<T>(
    url: string,
    load: (refresh: boolean) => Promise<JSONWebKeySet>,
    use: (keys: JSONWebKeySet) => Promise<T>,
  ) {
    const keys = await load(false);
    try {
      return await use(keys);
    } catch (e) {
      const unknownKid = (e as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY";
      const entry = this.cache.get(url);
      if (!unknownKid || (entry && this.now() - entry.fetchedAt < UNKNOWN_KID_REFETCH_MS)) throw e;
      return use(await load(true));
    }
  }

  private async verifyOidc(
    token: string,
    info: Extract<AuthInfo, { kind: "oidc" }>,
    issuer: string,
  ): Promise<VerifiedIdentity> {
    const meta = await this.discover(issuer);
    const failed = () =>
      unauthenticated(
        "Unauthenticated",
        "Could not verify OIDC token claim. Check that the token signature is valid and the token hasn't expired.",
      );
    try {
      const { payload } = await this.withKeys(
        meta.jwks_uri,
        (refresh) => this.oidcJwks(meta.jwks_uri, refresh),
        (keys) =>
          jwtVerify(token, createLocalJWKSet(keys), {
            algorithms: ["RS256", "EdDSA"],
            issuer: meta.issuer,
            audience: info.applicationId,
            requiredClaims: ["exp", "iat", "sub"],
            currentDate: new Date(this.now()),
          }),
      );
      // The OIDC verifier refuses tokens for more than one audience.
      if (audiences(payload.aud).some((a) => a !== info.applicationId)) throw failed();
      return { identity: identityFromOidc(payload), expiresAt: payload.exp! };
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      throw failed();
    }
  }

  private async customJwks(uri: string, refresh: boolean): Promise<JSONWebKeySet> {
    if (uri.startsWith("data:")) {
      try {
        return (await (await this.fetchFn(uri)).json()) as JSONWebKeySet;
      } catch {
        throw unauthenticated(
          "InvalidAuthHeader",
          "Invalid JWKS data URL. Check that the data URL is properly formatted and contains valid base64-encoded JSON.",
        );
      }
    }
    try {
      new URL(uri);
    } catch {
      throw badRequest(
        "InvalidAuthConfig",
        `Invalid JWKS URL '${uri}'. Check that the URL in your auth config is properly formatted.`,
      );
    }
    const body = await this.getJson(
      uri,
      async (r) => {
        if (r.status !== 200)
          throw unauthenticated(
            "InvalidAuthHeader",
            `Could not fetch JWKS from URL '${uri}': HTTP ${r.status} ${r.statusText || "Unknown"}. Check that the URL is correct and accessible.`,
          );
        const type = r.headers.get("content-type") ?? "unknown";
        const [essence, ...params] = type.split(";").map((s) => s.trim().toLowerCase());
        const charset = params.find((x) => x.startsWith("charset="));
        if (!JWKS_MEDIA_TYPES.includes(essence) || (charset !== undefined && charset !== "charset=utf-8"))
          throw unauthenticated(
            "InvalidAuthHeader",
            `Invalid Content-Type '${type}' when fetching JWKS from '${uri}'. Expected 'application/json' or 'application/jwk-set+json'.`,
          );
      },
      refresh,
    ).catch((e) => {
      if (e instanceof AuthenticationError) throw e;
      throw unauthenticated(
        "InvalidAuthHeader",
        `Could not fetch JWKS from URL '${uri}': ${(e as Error).message}. Check that the URL is correct and accessible.`,
      );
    });
    if (typeof body !== "object" || body === null || !Array.isArray((body as JSONWebKeySet).keys))
      throw unauthenticated(
        "InvalidAuthHeader",
        `Invalid JWKS response body from '${uri}'. The response is not valid JSON or doesn't match the expected JWKS format.`,
      );
    return body as JSONWebKeySet;
  }

  private async verifyCustom(token: string, info: Extract<AuthInfo, { kind: "customJwt" }>): Promise<VerifiedIdentity> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      kid = undefined;
    }
    const decodeFailed = () =>
      unauthenticated(
        "InvalidAuthHeader",
        kid === undefined
          ? "Could not decode token. JWT may be missing a 'kid' (key ID) header."
          : this.opts.redactErrors
            ? "Could not decode token. The JWT's 'kid' (key ID) header doesn't match any key in the provider's JWKS, or the JWT signature is invalid."
            : `Could not decode token. The JWT's 'kid' (key ID) header is '${kid}', does this key match any key in the provider's JWKS?`,
      );
    // As Convex's decoder, a token must name its key.
    if (kid === undefined) throw decodeFailed();
    let payload: Record<string, unknown>;
    try {
      const { payload: bytes } = await this.withKeys(
        info.jwks,
        (refresh) => this.customJwks(info.jwks, refresh),
        (keys) => compactVerify(token, createLocalJWKSet(keys), { algorithms: [info.algorithm] }),
      );
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      throw decodeFailed();
    }
    const tokenIssuer = payload.iss;
    if (typeof tokenIssuer !== "string")
      throw unauthenticated(
        "InvalidAuthHeader",
        "Missing issuer claim ('iss') in JWT payload. The JWT must include an 'iss' claim that matches one of your configured auth providers.",
      );
    if (!sameIssuer(withHttps(tokenIssuer), info.issuer))
      throw unauthenticated("InvalidAuthHeader", `Invalid issuer: ${tokenIssuer} != ${info.issuer}`);
    if (info.applicationId !== undefined) {
      if (payload.aud === undefined)
        throw unauthenticated(
          "InvalidAuthHeader",
          "Missing audience claim ('aud') in JWT payload. The JWT must include an 'aud' claim that matches your configured application ID.",
        );
      const auds = audiences(payload.aud);
      if (!auds.includes(info.applicationId))
        throw unauthenticated(
          "InvalidAuthHeader",
          `Invalid audience: ${info.applicationId} not in [${auds.map((a) => JSON.stringify(a)).join(", ")}]`,
        );
    }
    const now = this.now() / 1000;
    const invalid = (why: string) => unauthenticated("InvalidAuthHeader", `Could not validate token: ${why}`);
    if (typeof payload.exp === "number" && payload.exp < now - CUSTOM_JWT_LEEWAY_S) throw invalid("Token expired");
    if (typeof payload.nbf === "number" && payload.nbf > now + CUSTOM_JWT_LEEWAY_S)
      throw invalid("Token not yet valid");
    if (typeof payload.iat === "number" && payload.iat > now + CUSTOM_JWT_LEEWAY_S)
      throw invalid("Token issued in the future");
    if (typeof payload.sub !== "string") throw unauthenticated("InvalidAuthHeader", "Missing subject");
    if (typeof payload.exp !== "number") throw unauthenticated("InvalidAuthHeader", "Missing expiry");
    return { identity: identityFromCustomJwt(payload), expiresAt: payload.exp };
  }
}
