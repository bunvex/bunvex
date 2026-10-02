// `bunvex-local-backend` (STUDY-40 L1): the backend as its own program, as Convex's `convex-local-backend`
// (crates/local_backend/src/config.rs, main.rs) with its flags and defaults:
//
//   bunvex-local-backend [options] [db_spec]
//   bunvex-local-backend keygen admin-key --instance-name <name> --instance-secret <hex>
//
// - `db_spec`: a SQLite file (default `bunvex_local_backend.sqlite3`) or, with `--db postgres|mysql|mongodb`,
//   the database's URL (it names the database, DV-110);
// - `--port` 3210 and `--site-proxy-port` 3211 on `--interface` (0.0.0.0); `--cloud-origin` / `--site-origin`
//   (a pair; Convex's `--convex-origin` / `--convex-site`) are the public URLs;
// - `--instance-name` (default bunvex-self-hosted) and `--instance-secret` (required; 32 hex bytes): the
//   executable never generates a secret — the Docker scripts and `bunvex dev` do;
// - files and pushed code under `--local-storage` (default `bunvex_local_storage`), or S3 (`--s3-storage`,
//   from the environment's S3 variables, for each use case whose bucket is set: STUDY-38 K4);
// - `--do-not-require-ssl`, `--redact-logs-to-client`.
// SIGINT / SIGTERM stop it.
import { resolve } from "node:path";
import { DEFAULT_INSTANCE_NAME, defineSchema, Engine, type Persistence } from "@bunvex/core";
import { blobStoreFromEnv, LocalBlobStore, s3OptionsFromEnv } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "./admin-keys.ts";
import { Functions } from "./functions.ts";
import { openPersistence } from "./persistence.ts";
import { createServer } from "./server.ts";

export type LocalBackendIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export const LOCAL_BACKEND_USAGE = `Usage: bunvex-local-backend [options] [db_spec]
       bunvex-local-backend keygen admin-key --instance-name <name> --instance-secret <hex>

The bunvex backend.

Arguments:
  [db_spec]                  SQLite: the file (default bunvex_local_backend.sqlite3); otherwise the database URL

Options:
  -d, --db <driver>          sqlite (default), postgres, mysql or mongodb
  -i, --interface <addr>     the interface to bind to (default 0.0.0.0)
  -p, --port <n>             the API's port (default 3210)
      --site-proxy-port <n>  the HTTP actions' port (default 3211)
      --cloud-origin <url>   the API's public URL (with --site-origin; default http://127.0.0.1:<port>)
      --site-origin <url>    the HTTP actions' public URL (default http://127.0.0.1:<site-proxy-port>)
      --instance-name <name> default ${DEFAULT_INSTANCE_NAME}; requires --instance-secret
      --instance-secret <hex> required: 32 bytes, hex-encoded (\`openssl rand -hex 32\`)
      --local-storage <dir>  where files and pushed code live (default bunvex_local_storage)
      --s3-storage           keep them in S3 instead (S3_STORAGE_FILES_BUCKET, S3_STORAGE_MODULES_BUCKET, AWS_*)
      --do-not-require-ssl   allow an unencrypted database connection
      --redact-logs-to-client  do not send log lines and errors' details to clients
  -V, --version              print the version
  -h, --help                 print this help`;

export type LocalBackendFlags = {
  dbSpec: string;
  db: "sqlite" | "postgres" | "mysql" | "mongodb";
  hostname: string;
  port: number;
  sitePort: number;
  cloudOrigin?: string;
  siteOrigin?: string;
  instanceName: string;
  instanceSecret?: string;
  localStorage: string;
  s3: boolean;
  doNotRequireSsl: boolean;
  redact: boolean;
};

const VALUED: Record<string, string> = {
  "-d": "--db",
  "--db": "--db",
  "-i": "--interface",
  "--interface": "--interface",
  "-p": "--port",
  "--port": "--port",
  "--site-proxy-port": "--site-proxy-port",
  "--cloud-origin": "--cloud-origin",
  "--site-origin": "--site-origin",
  "--instance-name": "--instance-name",
  "--instance-secret": "--instance-secret",
  "--local-storage": "--local-storage",
};

/** Convex's instance secret check: 32 bytes, hex-encoded. */
export function instanceSecretError(secret: string): string | null {
  if (!/^[0-9a-fA-F]*$/.test(secret) || secret.length % 2) return "--instance-secret must be hex-encoded";
  const n = secret.length / 2;
  return n === 32 ? null : `Hex-decoded key was ${n} bytes, not 32`;
}

/** The flags, checked as Convex's clap definitions check them; a message on misuse. */
export function parseLocalBackendFlags(args: string[]): LocalBackendFlags | string {
  const f: LocalBackendFlags = {
    dbSpec: "bunvex_local_backend.sqlite3",
    db: "sqlite",
    hostname: "0.0.0.0",
    port: 3210,
    sitePort: 3211,
    instanceName: DEFAULT_INSTANCE_NAME,
    localStorage: "bunvex_local_storage",
    s3: false,
    doNotRequireSsl: false,
    redact: false,
  };
  let positional: string | undefined;
  let named = false;
  let localStorageGiven = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [raw, inline] =
      a.startsWith("--") && a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
    const name = VALUED[raw];
    if (raw === "--s3-storage") f.s3 = true;
    else if (raw === "--do-not-require-ssl") f.doNotRequireSsl = true;
    else if (raw === "--redact-logs-to-client") f.redact = true;
    else if (name) {
      const v = inline ?? args[++i];
      if (v === undefined)
        return `a value is required for '${name} <${name.slice(2).toUpperCase()}>' but none was supplied`;
      if (name === "--db") {
        if (!["sqlite", "postgres", "mysql", "mongodb"].includes(v))
          return `invalid value '${v}' for '--db <DB>': possible values: sqlite, postgres, mysql, mongodb`;
        f.db = v as LocalBackendFlags["db"];
      } else if (name === "--port" || name === "--site-proxy-port") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) return `invalid value '${v}' for '${name}': not a port number`;
        if (name === "--port") f.port = n;
        else f.sitePort = n;
      } else if (name === "--interface") f.hostname = v;
      else if (name === "--cloud-origin") f.cloudOrigin = v;
      else if (name === "--site-origin") f.siteOrigin = v;
      else if (name === "--instance-name") {
        f.instanceName = v;
        named = true;
      } else if (name === "--instance-secret") f.instanceSecret = v;
      else {
        f.localStorage = v;
        localStorageGiven = true;
      }
    } else if (a.startsWith("-")) return `unexpected argument '${a}' found`;
    else if (positional === undefined) positional = a;
    else return `unexpected argument '${a}' found`;
  }
  if (positional !== undefined) f.dbSpec = positional;
  else if (f.db !== "sqlite") return `--db ${f.db} needs the database's URL as the db_spec argument`;
  if (f.s3 && localStorageGiven)
    return "the argument '--s3-storage' cannot be used with '--local-storage <LOCAL_STORAGE>'";
  if (named && f.instanceSecret === undefined)
    return "the following required arguments were not provided:\n  --instance-secret <INSTANCE_SECRET>";
  if (f.instanceSecret === undefined) return "--instance-secret is required. Generate one with `openssl rand -hex 32`";
  const bad = instanceSecretError(f.instanceSecret);
  if (bad) return bad;
  if (!!f.cloudOrigin !== !!f.siteOrigin)
    return f.cloudOrigin
      ? "the following required arguments were not provided:\n  --site-origin <SITE_ORIGIN>"
      : "the following required arguments were not provided:\n  --cloud-origin <CLOUD_ORIGIN>";
  for (const o of [f.cloudOrigin, f.siteOrigin])
    if (o && !/^https?:\/\//.test(o)) return `Origin url should start with https:// or http:// but got '${o}'`;
  return f;
}

export type RunningLocalBackend = { url: string; siteUrl: string | null; stop: () => Promise<void> };

/** Start the backend (the program waits on it; tests and `bunvex dev` stop it). */
export async function startLocalBackend(f: LocalBackendFlags, io: LocalBackendIo): Promise<RunningLocalBackend> {
  let persistence: Persistence;
  if (f.db === "sqlite") {
    const { SqlitePersistence } = await import("@bunvex/core/persistence/sqlite");
    persistence = new SqlitePersistence(resolve(io.cwd, f.dbSpec), { durable: true });
  } else persistence = await openPersistence({ kind: f.db, url: f.dbSpec, requireSsl: !f.doNotRequireSsl, pool: 16 });
  const engine = await new Engine(defineSchema({}), persistence, {
    instanceName: f.instanceName,
    instanceSecret: f.instanceSecret,
    storedSchema: true,
    lease: { ttlMs: Number(io.env.LEASE_TTL_MS ?? 5000), waitMs: Number(io.env.LEASE_WAIT_MS ?? 0) },
  }).init();
  const storage = (useCase: "files" | "modules" | "exports" | "snapshot_imports") => {
    // With --s3-storage, each use case whose bucket is set is in S3, the others stay local (STUDY-38 K4).
    if (!f.s3 || !s3OptionsFromEnv(io.env, useCase))
      return new LocalBlobStore(resolve(io.cwd, f.localStorage), useCase);
    return blobStoreFromEnv(io.env, {
      useCase,
      s3Prefix: () => engine.instanceSetting("s3Prefix", () => `bunvex-${crypto.randomUUID()}/`),
    });
  };
  const app = createServer({
    engine,
    functions: new Functions(engine),
    port: f.port,
    sitePort: f.sitePort,
    hostname: f.hostname,
    ...(f.cloudOrigin ? { cloudOrigin: f.cloudOrigin, siteOrigin: f.siteOrigin } : {}),
    ...(f.redact ? { redactLogsToClient: true } : {}),
    fileStorage: storage("files"),
    moduleStorage: storage("modules"),
    exportStorage: storage("exports"),
    importStorage: storage("snapshot_imports"),
    deployable: true,
    label: f.db,
  });
  await app.codeReady.catch(() => {});
  const url = (f.cloudOrigin ?? `http://127.0.0.1:${app.server.port}`).replace(/\/$/, "");
  return {
    url,
    siteUrl: app.siteUrl,
    stop: async () => {
      await app.shutdown();
      await engine.close();
    },
  };
}

/** The program: `keygen admin-key`, or the backend until SIGINT / SIGTERM. Resolves to the exit code. */
export async function localBackendMain(args: string[], io: LocalBackendIo, version: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(LOCAL_BACKEND_USAGE);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-V") {
    io.out(`bunvex-local-backend ${version}`);
    return 0;
  }
  if (args[0] === "keygen") {
    if (args[1] !== "admin-key") {
      io.err("Usage: bunvex-local-backend keygen admin-key --instance-name <name> --instance-secret <hex>");
      return 2;
    }
    let name: string | undefined;
    let secret: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--instance-name") name = args[++i];
      else if (args[i] === "--instance-secret") secret = args[++i];
      else {
        io.err(`unexpected argument '${args[i]}' found`);
        return 2;
      }
    }
    if (!name || !secret) {
      io.err(
        "the following required arguments were not provided:\n  --instance-name <INSTANCE_NAME>\n  --instance-secret <INSTANCE_SECRET>",
      );
      return 2;
    }
    const bad = instanceSecretError(secret);
    if (bad) {
      io.err(bad);
      return 2;
    }
    io.out(issueAdminKey({ instanceName: name, cipherKey: adminKeyCipherKey(secret) }));
    return 0;
  }
  const flags = parseLocalBackendFlags(args);
  if (typeof flags === "string") {
    io.err(`error: ${flags}\n\n${LOCAL_BACKEND_USAGE}`);
    return 2;
  }
  let running: RunningLocalBackend;
  try {
    running = await startLocalBackend(flags, io);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
  io.err(`bunvex-local-backend ${version}: instance ${flags.instanceName}, ${flags.db}`);
  io.err(`the API at ${running.url}${running.siteUrl ? `, HTTP actions at ${running.siteUrl}` : ""}`);
  await new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        io.err("bunvex-local-backend: stopping");
        void running.stop().then(done, done);
      });
  });
  return 0;
}
