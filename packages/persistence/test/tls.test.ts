// The TLS decision for Postgres and MySQL (STUDY-25 L8, DV-109): Convex's defaults, without a database.
// The real connections are in tls-db.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { builtInCas, explainTlsError, mysqlTls, postgresTls } from "../src/tls.ts";

const one = { host: ["db.example"], port: [5432] };
const two = { host: ["a.example", "b.example"], port: [5432, 5433] };
const says = (answers: Record<string, boolean | undefined>) => async (t: { host?: string; path?: string }) =>
  answers[t.host ?? t.path ?? ""];
const dir = mkdtempSync(join(tmpdir(), "bunvex-tls-"));
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const caFile = join(dir, "ca.pem");
writeFileSync(caFile, CA);

describe("Postgres", () => {
  test("default: TLS required and verified against the built-in roots; read-write sessions", async () => {
    const r = await postgresTls("postgres://u@db.example/app", one, {}, says({ "db.example": true }));
    expect(r.target_session_attrs).toBe("read-write");
    expect(r.ssl).toEqual({ rejectUnauthorized: true, ca: builtInCas() });
  });

  test("default: a server without TLS is refused with an error that names DO_NOT_REQUIRE_SSL", async () => {
    const p = postgresTls("postgres://u@db.example/app", one, {}, says({ "db.example": false }));
    await expect(p).rejects.toThrow(
      /^Postgres at db\.example:5432 does not accept TLS connections, and bunvex requires TLS by default: set DO_NOT_REQUIRE_SSL=1/,
    );
    // One host of several without TLS is enough to refuse; an unreachable one is left to the driver.
    await expect(postgresTls("x", two, {}, says({ "a.example": true, "b.example": false }))).rejects.toThrow(
      "b.example:5433",
    );
    expect((await postgresTls("x", two, {}, says({ "a.example": true }))).ssl).toBeTruthy();
  });

  test("default: the requirement overrides a weaker sslmode in the URL (Convex appends sslmode=require)", async () => {
    for (const mode of ["disable", "prefer", "allow"]) {
      const p = postgresTls(`postgres://u@db.example/app?sslmode=${mode}`, one, {}, says({ "db.example": false }));
      await expect(p).rejects.toThrow("does not accept TLS");
    }
  });

  test("a socket path: Postgres has no TLS there, so the default refuses it", async () => {
    const t = { host: ["/tmp"], port: [5432], path: "/tmp/.s.PGSQL.5432" };
    await expect(postgresTls("x", t, {}, says({ "/tmp/.s.PGSQL.5432": false }))).rejects.toThrow(
      "Postgres at /tmp/.s.PGSQL.5432 does not accept TLS",
    );
  });

  test("PG_CA_FILE adds a CA to the built-in roots", async () => {
    const r = await postgresTls("x", one, { caFile }, says({ "db.example": true }));
    expect(r.ssl).toEqual({ rejectUnauthorized: true, ca: [...builtInCas(), CA] });
    await expect(postgresTls("x", one, { caFile: join(dir, "missing.pem") }, says({}))).rejects.toThrow(
      "cannot read the CA file",
    );
  });

  describe("DO_NOT_REQUIRE_SSL: the URL's sslmode, prefer by default", () => {
    const off = { requireSsl: false };
    test("prefer: TLS (verified) when the server offers it, plain when it says it has none", async () => {
      expect((await postgresTls("postgres://h/app", one, off, says({ "db.example": true }))).ssl).toMatchObject({
        rejectUnauthorized: true,
      });
      expect((await postgresTls("postgres://h/app", one, off, says({ "db.example": false }))).ssl).toBe(false);
      // Unreachable: TLS is attempted (the driver reports the connection error itself).
      expect((await postgresTls("postgres://h/app", one, off, says({}))).ssl).toBeTruthy();
    });
    test("disable: plain, without asking the server", async () => {
      let asked = false;
      const r = await postgresTls("postgres://h/app?sslmode=disable", one, off, async () => {
        asked = true;
        return true;
      });
      expect([r.ssl, asked, r.target_session_attrs]).toEqual([false, false, "read-write"]);
    });
    test("require / verify-full in the URL: required", async () => {
      for (const mode of ["require", "verify-ca", "verify-full"]) {
        const p = postgresTls(`postgres://h/app?sslmode=${mode}`, one, off, says({ "db.example": false }));
        await expect(p).rejects.toThrow("does not accept TLS");
      }
    });
    test("an unknown sslmode is an error", async () => {
      await expect(postgresTls("postgres://h/app?sslmode=bogus", one, off, says({}))).rejects.toThrow(
        "unknown sslmode=bogus",
      );
    });
  });
});

describe("MySQL", () => {
  const roots = builtInCas();
  test("default: TLS required, CA and host name verified (Convex: require_ssl=true&verify_ca=true)", () => {
    expect(mysqlTls("mysql://u@h:3306/app")).toEqual({
      uri: "mysql://u@h:3306/app",
      ssl: { rejectUnauthorized: true, verifyIdentity: true, ca: roots },
    });
  });

  test("default: the URL cannot turn the requirement or CA verification off; it can skip the host name", () => {
    const r = mysqlTls("mysql://u@h/app?require_ssl=false&verify_ca=false&verify_identity=false&charset=utf8mb4");
    expect(r).toEqual({
      uri: "mysql://u@h/app?charset=utf8mb4",
      ssl: { rejectUnauthorized: true, verifyIdentity: false, ca: roots },
    });
    // A mysql2 `ssl` parameter would override the option, so it is dropped while TLS is required.
    expect(mysqlTls('mysql://u@h/app?ssl={"rejectUnauthorized":false}').uri).toBe("mysql://u@h/app");
  });

  test("MYSQL_CA_FILE adds a CA; built_in_roots=false keeps only it", () => {
    expect(mysqlTls("mysql://u@h/app", { caFile }).ssl?.ca).toEqual([...roots, CA]);
    expect(mysqlTls("mysql://u@h/app?built_in_roots=false", { caFile }).ssl?.ca).toEqual([CA]);
  });

  describe("DO_NOT_REQUIRE_SSL: as the URL says", () => {
    const off = { requireSsl: false };
    test("plain by default; the URL as given", () => {
      expect(mysqlTls("mysql://u@h/app", off)).toEqual({ uri: "mysql://u@h/app" });
      const ssl = 'mysql://u@h/app?ssl={"rejectUnauthorized":false}';
      expect(mysqlTls(ssl, off)).toEqual({ uri: ssl });
    });
    test("require_ssl=true in the URL: TLS, with its verify_ca / verify_identity", () => {
      expect(mysqlTls("mysql://u@h/app?require_ssl=true&verify_ca=false", off)).toEqual({
        uri: "mysql://u@h/app",
        ssl: { rejectUnauthorized: false, verifyIdentity: true, ca: roots },
      });
    });
    test("MYSQL_CA_FILE alone turns TLS on, unless the URL says require_ssl=false (Convex)", () => {
      expect(mysqlTls("mysql://u@h/app", { ...off, caFile }).ssl).toMatchObject({ rejectUnauthorized: true });
      expect(mysqlTls("mysql://u@h/app?require_ssl=false", { ...off, caFile }).ssl).toBeUndefined();
    });
    test("a malformed flag is an error", () => {
      expect(() => mysqlTls("mysql://u@h/app?require_ssl=1", off)).toThrow("require_ssl=1 must be true or false");
    });
  });
});

test("the built-in roots are the operating system's and the bundled ones", () => {
  const roots = new Set(builtInCas());
  for (const c of tls.getCACertificates("system")) expect(roots.has(c)).toBe(true);
  for (const c of tls.getCACertificates("bundled")) expect(roots.has(c)).toBe(true);
});

describe("errors", () => {
  test("a server without TLS, or a certificate that does not verify, says what to do", () => {
    const noTls = explainTlsError(Object.assign(new Error("x"), { code: "HANDSHAKE_NO_SSL_SUPPORT" }), "MySQL", "M");
    expect(String(noTls)).toContain("MySQL does not accept TLS connections");
    expect(String(noTls)).toContain("DO_NOT_REQUIRE_SSL=1");
    const bad = explainTlsError(
      Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
      "Postgres",
      "PG_CA_FILE",
    ) as Error & { code: string };
    expect(bad.message).toContain("Postgres's TLS certificate does not verify (UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(bad.message).toContain("set PG_CA_FILE");
    expect(bad.code).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const other = new Error("password authentication failed");
    expect(explainTlsError(other, "Postgres", "PG_CA_FILE")).toBe(other);
  });
});
