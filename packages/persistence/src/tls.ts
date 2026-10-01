// TLS for the SQL drivers, with Convex's defaults (STUDY-25 L8, DV-109): a connection must be encrypted and
// the server's certificate verified (chain and host name) unless the operator turns the requirement off
// (`requireSsl: false`, the server's DO_NOT_REQUIRE_SSL).
//
// Convex (crates/clusters/src/lib.rs:39-50, :69-77; crates/postgres/src/lib.rs:423-454;
// crates/mysql/src/connection.rs:667-709):
//   - Postgres: `sslmode=require` is appended to the URL, so it overrides a weaker `sslmode` the URL sets;
//     rustls verifies the certificate against the system roots plus PG_CA_FILE. Without the requirement the
//     URL's `sslmode` applies, `prefer` by default: TLS when the server offers it (still verified), plain
//     when it does not. `target_session_attrs=read-write` is always set.
//   - MySQL: `require_ssl=true&verify_ca=true` is appended (host name verification stays on, mysql_async's
//     default, unless the URL says `verify_identity=false`); the roots are the built-in ones plus
//     MYSQL_CA_FILE. MYSQL_CA_FILE alone turns TLS on, unless the URL says `require_ssl=false`.
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

export type TlsOptions = {
  /** Require an encrypted, verified connection (default true). False: as the URL says (Postgres prefers TLS). */
  requireSsl?: boolean;
  /** A PEM file of extra CA certificates trusted besides the built-in roots (PG_CA_FILE / MYSQL_CA_FILE). */
  caFile?: string;
};

const OFF_HINT =
  "set DO_NOT_REQUIRE_SSL=1 to connect without TLS (a local or test database only), or enable TLS on the server";

/**
 * The roots a verified connection trusts by default: the operating system's (what Convex's Postgres driver
 * loads, rustls-native-certs) and the runtime's bundled Mozilla set (what its MySQL driver builds in).
 */
export function builtInCas(): string[] {
  try {
    return [...new Set([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")])];
  } catch {
    return [...tls.rootCertificates];
  }
}

/** The CA list a verified connection trusts: the built-in roots plus the operator's CA file. */
function trustedCas(caFile: string | undefined, builtIn = true): string[] {
  const cas = builtIn ? builtInCas() : [];
  if (caFile) {
    let pem: string;
    try {
      pem = readFileSync(caFile, "utf8");
    } catch (e) {
      throw new Error(`cannot read the CA file ${caFile}: ${(e as Error).message}`);
    }
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error(`the CA file ${caFile} holds no PEM certificate`);
    cas.push(pem);
  }
  return cas;
}

// ---------------------------------------------------------------------------------------------- Postgres

/** The parts of a parsed Postgres connection the TLS decision needs (the driver's own parse: `sql.options`). */
export type PgTarget = { host: string[]; port: number[]; path?: string | false };

export type PgTls = {
  /** The `ssl` option for the `postgres` driver: false (plain) or a verified TLS configuration. */
  ssl: false | tls.ConnectionOptions;
  target_session_attrs: "read-write";
};

/** The `sslmode` the URL sets, if any (libpq's names; `postgres` also reads `ssl`). */
export function urlSslMode(url: string): string | undefined {
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get("sslmode") ?? params.get("ssl") ?? undefined;
}

/**
 * Decides how to connect to Postgres. `probe` asks each host whether it accepts TLS (the protocol's
 * SSLRequest), so a refusal is reported clearly up front instead of as a reset socket, and so `prefer`
 * can fall back to plain only when the server has no TLS, as libpq and Convex do.
 */
export async function postgresTls(
  url: string,
  target: PgTarget,
  opts: TlsOptions = {},
  probe: (t: { host?: string; port?: number; path?: string }) => Promise<boolean | undefined> = pgAcceptsTls,
): Promise<PgTls> {
  const requireSsl = opts.requireSsl ?? true;
  const mode = requireSsl ? "require" : (urlSslMode(url) ?? "prefer");
  const verified = (): tls.ConnectionOptions => ({ rejectUnauthorized: true, ca: trustedCas(opts.caFile) });
  if (mode === "disable" || mode === "false") return { ssl: false, target_session_attrs: "read-write" };
  if (!["allow", "prefer", "require", "verify-ca", "verify-full", "true"].includes(mode))
    throw new Error(`unknown sslmode=${mode} (disable, prefer, require, verify-ca, verify-full)`);
  const where = target.path
    ? [{ path: target.path, name: target.path }]
    : target.host.map((host, i) => ({ host, port: target.port[i] ?? target.port[0] ?? 5432 }));
  const answers = await Promise.all(where.map((w) => probe(w)));
  const plain = where.filter((_, i) => answers[i] === false);
  if (mode === "allow" || mode === "prefer") {
    // Plain only when a server answered that it has no TLS; otherwise TLS, verified as Convex verifies it.
    return { ssl: plain.length ? false : verified(), target_session_attrs: "read-write" };
  }
  if (plain.length) {
    const names = plain.map((w) => ("path" in w ? w.path : `${w.host}:${w.port}`)).join(", ");
    throw new Error(
      `Postgres at ${names} does not accept TLS connections, and bunvex requires TLS by default: ${OFF_HINT}`,
    );
  }
  return { ssl: verified(), target_session_attrs: "read-write" };
}

/**
 * Asks a Postgres server whether it accepts TLS: the SSLRequest message, answered by one byte, `S` or `N`.
 * Undefined when the server cannot be reached (the driver then reports that itself).
 */
export function pgAcceptsTls(t: { host?: string; port?: number; path?: string }): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const socket = t.path ? net.connect({ path: t.path }) : net.connect({ host: t.host, port: t.port ?? 5432 });
    const done = (v: boolean | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), 10_000);
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]))); // 80877103
    socket.once("data", (b: Buffer) => done(b[0] === 0x53 /* S */ ? true : b[0] === 0x4e /* N */ ? false : undefined));
    socket.once("error", () => done(undefined));
    socket.once("close", () => done(undefined));
  });
}

// ------------------------------------------------------------------------------------------------- MySQL

export type MysqlTls = {
  /** The URL without the TLS parameters this module consumed (mysql2 would let them override `ssl`). */
  uri: string;
  ssl?: { rejectUnauthorized: boolean; verifyIdentity: boolean; ca: string[] };
};

const bool = (name: string, v: string | null): boolean | undefined => {
  if (v === null) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`MySQL URL: ${name}=${v} must be true or false`);
};

/**
 * Decides how to connect to MySQL. The URL may carry the TLS parameters Convex's MySQL URLs use
 * (`require_ssl`, `verify_ca`, `verify_identity`, `built_in_roots`); they are read and removed. A mysql2
 * `ssl` parameter in the URL is kept only when bunvex does not require TLS (as given, then).
 */
export function mysqlTls(url: string, opts: TlsOptions = {}): MysqlTls {
  const requireSsl = opts.requireSsl ?? true;
  const q = url.indexOf("?");
  const params = new URLSearchParams(q < 0 ? "" : url.slice(q + 1));
  let consumed = false;
  const take = (name: string) => {
    const v = params.get(name);
    if (v !== null) consumed = true;
    params.delete(name);
    return bool(name, v);
  };
  const urlRequire = take("require_ssl");
  const verifyCa = requireSsl ? true : (take("verify_ca") ?? true);
  if (requireSsl && params.has("verify_ca")) {
    consumed = true;
    params.delete("verify_ca");
  }
  const verifyIdentity = take("verify_identity") ?? true;
  const builtIn = take("built_in_roots") ?? true;
  // Required by bunvex; or asked by the URL; or implied by a CA file unless the URL turns it off (Convex).
  const on = requireSsl || urlRequire === true || (!!opts.caFile && urlRequire !== false);
  if (on && params.has("ssl")) {
    consumed = true;
    params.delete("ssl");
  }
  const rest = params.toString();
  const uri = !consumed ? url : (q < 0 ? url : url.slice(0, q)) + (rest ? `?${rest}` : "");
  if (!on) return { uri };
  return { uri, ssl: { rejectUnauthorized: verifyCa, verifyIdentity, ca: trustedCas(opts.caFile, builtIn) } };
}

// ------------------------------------------------------------------------------------------------ errors

const VERIFY_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HANDSHAKE_SSL_ERROR", // mysql2 wraps the TLS error under this code, keeping its message
]);

/**
 * A connection error with what to do about it: a server without TLS, or a certificate that does not verify.
 * Other errors are returned unchanged.
 */
export function explainTlsError(e: unknown, db: "Postgres" | "MySQL", caVar: string): unknown {
  const code = (e as { code?: string }).code ?? "";
  const msg = (e as Error).message ?? String(e);
  if (code === "HANDSHAKE_NO_SSL_SUPPORT")
    return withCause(`${db} does not accept TLS connections, and bunvex requires TLS by default: ${OFF_HINT}`, e);
  if (VERIFY_CODES.has(code))
    return withCause(
      `${db}'s TLS certificate does not verify (${code}: ${msg}). bunvex verifies the server's certificate ` +
        `by default: set ${caVar} to a PEM file with the CA that signed it, or ${OFF_HINT}`,
      e,
    );
  return e;
}

function withCause(message: string, cause: unknown) {
  const err = new Error(message, { cause });
  (err as { code?: string }).code = (cause as { code?: string }).code;
  return err;
}
