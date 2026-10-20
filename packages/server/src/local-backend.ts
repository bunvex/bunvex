// `bunvex-local-backend` (STUDY-40 L1): the backend as its own program, as Convex's `convex-local-backend`
// (crates/local_backend/src/config.rs, main.rs) with its flags and defaults:
//
//   bunvex-local-backend [options] [db_spec]
//   bunvex-local-backend keygen admin-key --instance-name <name> --instance-secret <hex>
//
// - `db_spec`: a SQLite file (default `bunvex_local_backend.sqlite3`) or, with `--db postgres|mysql|mongodb`,
//   the database's URL (without a database, the instance name's, as Convex: DV-417);
// - `--port` 3210 and `--site-proxy-port` 3211 on `--interface` (0.0.0.0); `--cloud-origin` / `--site-origin`
//   (a pair; Convex's `--convex-origin` / `--convex-site`) are the public URLs;
// - `--instance-name` (default bunvex-self-hosted) and `--instance-secret` (required; 32 hex bytes): the
//   executable never generates a secret — the Docker scripts and `bunvex dev` do. The secret may come from
//   INSTANCE_SECRET instead, the flag winning (DV-525: Convex's binary takes the flag only, which any user of
//   the machine can read in `/proc/<pid>/cmdline` or `ps`); the variable is then removed from the process's
//   environment, so nothing the backend starts inherits it;
// - files and pushed code under `--local-storage` (default `bunvex_local_storage`), or S3 (`--s3-storage`,
//   from the environment's S3 variables, for each use case whose bucket is set: STUDY-38 K4);
// - `--do-not-require-ssl`, `--redact-logs-to-client`;
// - the database's variables, which Convex's binary reads from its environment: `POSTGRES_TIMEOUT_SECONDS` /
//   `MYSQL_TIMEOUT_SECONDS` (its knobs; `MONGODB_TIMEOUT_SECONDS` too) and `PG_CA_FILE` / `MYSQL_CA_FILE` (its
//   connection code), read as an embedded server reads them (`persistenceConfigFromEnv`);
// - `--http-proxy <url>` (Convex's `--convex-http-proxy`, STUDY-80): the proxy actions' `fetch`, OIDC
//   discovery and JWKS, and the log sinks go through; without it, `--deny-addresses` (bunvex's own screen,
//   STUDY-80 P1, DV-325: `metadata` by default), and Convex's warning at start when that is `none`;
// - `--function-sandbox <vm|process>` (bunvex's own, AD-44): where pushed code runs. It wins over
//   `BUNVEX_FUNCTION_SANDBOX`; `BUNVEX_FUNCTION_SANDBOX_ISOLATION` picks `process`'s layers. Only `vm` exists so
//   far: `process` fails at start (STUDY-171).
// Misuse is reported as clap reports Convex's (`command-line.ts`, STUDY-172). SIGINT / SIGTERM stop it.
import { resolve } from "node:path";
import { DEFAULT_INSTANCE_NAME, defineSchema, Engine, type Persistence, type StorageType } from "@bunvex/core";
import { type BlobStore, blobStoreFromEnv, LocalBlobStore, s3OptionsFromEnv } from "@bunvex/file-storage";
import { ADDRESS_SCREENS, type AddressScreen, DEFAULT_ADDRESS_SCREEN } from "./address-screen.ts";
import { adminKeyCipherKey, issueAdminKey } from "./admin-keys.ts";
import { type ArgSpec, type CommandSpec, errorText, ipv4Error, parseCommand, portError } from "./command-line.ts";
import {
  FUNCTION_SANDBOXES,
  type FunctionSandbox,
  functionSandboxConfig,
  requireProcessExecutor,
} from "./function-executor.ts";
import { Functions } from "./functions.ts";
import { openPersistence, type PersistenceConfig, persistenceConfigFromEnv } from "./persistence.ts";
import { searchSegmentStore } from "./search-storage.ts";
import { createServer } from "./server.ts";

export type LocalBackendIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

export const LOCAL_BACKEND_USAGE = `The bunvex backend.

Usage: bunvex-local-backend [OPTIONS] [DB_SPEC] [COMMAND]

Commands:
  keygen  Generate keys without starting the server
  help    Print this message or the help of the given subcommand(s)

Arguments:
  [DB_SPEC]  SQLite: the file (default bunvex_local_backend.sqlite3); otherwise the database URL

Options:
  -d, --db <DB>                            sqlite (default), postgres, mysql or mongodb
  -i, --interface <INTERFACE>              the IPv4 interface to bind to (default 0.0.0.0)
  -p, --port <PORT>                        the API's port (default 3210)
      --site-proxy-port <SITE_PROXY_PORT>  the HTTP actions' port (default 3211)
      --cloud-origin <CLOUD_ORIGIN>        the API's public URL (with --site-origin; default http://127.0.0.1:<port>)
      --site-origin <SITE_ORIGIN>          the HTTP actions' public URL (default http://127.0.0.1:<site-proxy-port>)
      --http-proxy <HTTP_PROXY>            send actions' fetch requests through this proxy, to screen them for SSRF
      --deny-addresses <DENY_ADDRESSES>    without --http-proxy, refuse them to: metadata (default; link-local and
                                           cloud metadata), private (also loopback and private networks) or none
      --instance-name <INSTANCE_NAME>      default ${DEFAULT_INSTANCE_NAME}; requires --instance-secret
      --instance-secret <INSTANCE_SECRET>  required: 32 bytes, hex-encoded (\`openssl rand -hex 32\`);
                                           [env: INSTANCE_SECRET], which keeps it off the command line
      --local-storage <LOCAL_STORAGE>      where files and pushed code live (default bunvex_local_storage)
      --s3-storage                         keep them in S3 instead (S3_STORAGE_<USE CASE>_BUCKET, AWS_*)
      --do-not-require-ssl                 allow an unencrypted database connection
      --redact-logs-to-client              do not send log lines and errors' details to clients
      --function-sandbox <FUNCTION_SANDBOX>
                                           where functions run: vm (default; in this process) or process (a
                                           sandboxed process: not available yet); default BUNVEX_FUNCTION_SANDBOX
  -h, --help                               print this help
  -V, --version                            print the version`;

/** `keygen`'s help, as clap writes a subcommand's. */
export const KEYGEN_USAGE = `Generate keys without starting the server

Usage: bunvex-local-backend keygen <COMMAND>

Commands:
  admin-key  Print an admin key for the given instance to stdout
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help`;

/** `keygen admin-key`'s help. */
export const ADMIN_KEY_USAGE = `Print an admin key for the given instance to stdout

Usage: bunvex-local-backend keygen admin-key --instance-name <INSTANCE_NAME> --instance-secret <INSTANCE_SECRET>

Options:
      --instance-name <INSTANCE_NAME>      Instance name for this backend
      --instance-secret <INSTANCE_SECRET>  Instance secret for this backend [env: INSTANCE_SECRET]
  -h, --help                               Print help`;

/** Convex's warning at start without a proxy, in bunvex's words. */
export const NO_PROXY_WARNING =
  "Running without a proxy -- actions' `fetch` requests are unrestricted! (--http-proxy screens them)";

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
  httpProxy?: string;
  denyAddresses?: AddressScreen;
  functionSandbox?: FunctionSandbox;
};

const DB_DRIVERS = ["sqlite", "postgres", "mysql", "mongodb"] as const;
const HELP: ArgSpec = { id: "help", short: "h", action: "help" };

/**
 * The flags as Convex's clap fields (`config.rs`), in their order; bunvex's own (`--deny-addresses`,
 * `--function-sandbox`) as clap would have them. No `value_name` overrides: each value is named after its field.
 */
const LOCAL_BACKEND: CommandSpec = {
  name: "bunvex-local-backend",
  positional: "DB_SPEC",
  subcommands: ["keygen", "help"],
  args: [
    { id: "db", short: "d", value: { possible: DB_DRIVERS } },
    { id: "interface", short: "i", value: { check: ipv4Error } },
    { id: "port", short: "p", value: { check: portError } },
    { id: "site-proxy-port", value: { check: portError } },
    { id: "cloud-origin", value: { check: () => null }, requires: ["site-origin"] },
    { id: "site-origin", value: { check: () => null }, requires: ["cloud-origin"] },
    // As clap parses Convex's `Url`: a value that is not an absolute URL is refused here.
    {
      id: "http-proxy",
      value: {
        check: (v) =>
          !URL.canParse(v)
            ? /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)
              ? "invalid URL"
              : "relative URL without a base"
            : /^https?:$/.test(new URL(v).protocol)
              ? null
              : "the proxy's scheme must be http or https",
      },
    },
    { id: "deny-addresses", value: { possible: ADDRESS_SCREENS } },
    { id: "instance-name", value: { check: () => null }, requires: ["instance-secret"] },
    { id: "instance-secret", value: { check: () => null } },
    { id: "local-storage", value: { check: () => null }, group: "storage" },
    { id: "s3-storage", group: "storage" },
    { id: "do-not-require-ssl" },
    { id: "redact-logs-to-client" },
    { id: "function-sandbox", value: { possible: FUNCTION_SANDBOXES } },
    HELP,
    { id: "version", short: "V", action: "version" },
  ],
};
const KEYGEN: CommandSpec = {
  name: "bunvex-local-backend keygen",
  subcommands: ["admin-key", "help"],
  subcommandRequired: true,
  args: [HELP],
};
const ADMIN_KEY: CommandSpec = {
  name: "bunvex-local-backend keygen admin-key",
  args: [
    { id: "instance-name", value: { check: () => null }, required: true },
    { id: "instance-secret", value: { check: () => null }, required: true },
    HELP,
  ],
};

/** Convex's instance secret check (`DeploymentSecret::try_from`): 32 bytes, hex-encoded, after one optional `0x` /
 *  `0X` (`const_hex::decode` drops it; `0x0x…` is refused, STUDY-172 §7). */
export function instanceSecretError(secret: string): string | null {
  const hex = /^0[xX]/.test(secret) ? secret.slice(2) : secret;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return "Couldn't hexdecode key";
  const n = hex.length / 2;
  return n === 32 ? null : `Hex-decoded key was ${n} bytes, not 32`;
}

/**
 * The instance secret's variable (DV-525), read as clap reads an `env =` argument: when the flag is absent, and
 * an empty value is no value. The name is the one Convex's Docker image takes (`docker-compose.yml`).
 */
export const INSTANCE_SECRET_ENV = "INSTANCE_SECRET";
const secretFromEnv = (env: LocalBackendIo["env"]) => env[INSTANCE_SECRET_ENV] || undefined;
const fromEnv = (env: LocalBackendIo["env"]) => (secretFromEnv(env) ? ["instance-secret"] : []);

function flagsOf(values: Map<string, string | true>, positional: string | undefined, env: LocalBackendIo["env"]) {
  const v = (id: string) => values.get(id) as string | undefined;
  const f: LocalBackendFlags = {
    // Without one, a database's URL is missing (`localBackendFlagsError`).
    dbSpec: positional ?? ((values.get("db") ?? "sqlite") === "sqlite" ? "bunvex_local_backend.sqlite3" : ""),
    db: (v("db") ?? "sqlite") as LocalBackendFlags["db"],
    hostname: v("interface") ?? "0.0.0.0",
    port: Number(v("port") ?? 3210),
    sitePort: Number(v("site-proxy-port") ?? 3211),
    instanceName: v("instance-name") ?? DEFAULT_INSTANCE_NAME,
    localStorage: v("local-storage") ?? "bunvex_local_storage",
    s3: values.has("s3-storage"),
    doNotRequireSsl: values.has("do-not-require-ssl"),
    redact: values.has("redact-logs-to-client"),
  };
  const secret = v("instance-secret") ?? secretFromEnv(env);
  if (secret !== undefined) f.instanceSecret = secret;
  if (values.has("cloud-origin")) f.cloudOrigin = v("cloud-origin")!;
  if (values.has("site-origin")) f.siteOrigin = v("site-origin")!;
  if (values.has("http-proxy")) f.httpProxy = v("http-proxy")!;
  if (values.has("deny-addresses")) f.denyAddresses = v("deny-addresses") as AddressScreen;
  if (values.has("function-sandbox")) f.functionSandbox = v("function-sandbox") as FunctionSandbox;
  return f;
}

/**
 * The flags, parsed and checked as clap parses Convex's (`command-line.ts`, STUDY-172); on misuse, clap's whole
 * message (`error: …`, through "For more information, try '--help'."). `env` gives INSTANCE_SECRET when
 * `--instance-secret` is absent (DV-525). What Convex checks once the flags parse (the secret, the origins) is
 * `localBackendFlagsError`'s.
 */
export function parseLocalBackendFlags(args: string[], env: LocalBackendIo["env"] = {}): LocalBackendFlags | string {
  const r = parseCommand(LOCAL_BACKEND, args, fromEnv(env));
  if (r.kind === "ok") return flagsOf(r.values, r.positional, env);
  return r.kind === "error" ? r.text : `not a run of the backend: ${r.kind}`;
}

/**
 * What Convex's binary refuses once its flags parse, as `Error: <message>` and exit 1: no instance secret
 * (`LocalConfig::secret`), a secret that is not 32 hex bytes (`DeploymentSecret`), an origin that is not http(s)
 * (`convex_origin_url`, `convex_site_url`; an empty one is allowed). And bunvex's own: a database URL for `--db`.
 */
export function localBackendFlagsError(f: LocalBackendFlags): string | null {
  if (f.db !== "sqlite" && !f.dbSpec) return `--db ${f.db} needs the database's URL as the db_spec argument`;
  if (f.instanceSecret === undefined) return "--instance-secret is required. Generate one with `openssl rand -hex 32`";
  const bad = instanceSecretError(f.instanceSecret);
  if (bad) return bad;
  const http = (o: string | undefined) => !o || /^https?:\/\//.test(o);
  if (!http(f.cloudOrigin)) return `Origin url should start with https:// or http:// but got '${f.cloudOrigin}'`;
  if (!http(f.siteOrigin)) return `Site url should start with https:// or http:// but got '${f.siteOrigin}'`;
  return null;
}

/**
 * The database variables Convex's binary reads from its environment, for the driver the flags chose (`--db`), whatever
 * the environment's PERSISTENCE says: the call timeout (POSTGRES_TIMEOUT_SECONDS, MYSQL_TIMEOUT_SECONDS;
 * MONGODB_TIMEOUT_SECONDS for bunvex's MongoDB), the CA file (PG_CA_FILE, MYSQL_CA_FILE), and the pool's size and idle
 * lifetime (POSTGRES_/MYSQL_MAX_CONNECTIONS, *_INACTIVE_CONNECTION_LIFETIME_SECS; STUDY-147 §3.7). Read by
 * `persistenceConfigFromEnv`, as an embedded server reads them; the URL and the rest come from the flags.
 */
export function localBackendDatabaseEnv(
  db: LocalBackendFlags["db"],
  env: LocalBackendIo["env"],
): Pick<PersistenceConfig, "caFile" | "timeoutMs" | "pool" | "idleMs"> {
  // The URL variables are the entry script's business: only the driver's own variables are taken.
  const { caFile, timeoutMs, pool, idleMs } = persistenceConfigFromEnv({ ...env, PERSISTENCE: db }, () => {});
  return {
    ...(caFile === undefined ? {} : { caFile }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pool === undefined ? {} : { pool }),
    ...(idleMs === undefined ? {} : { idleMs }),
  };
}

/** Convex's refusal of a time zone other than UTC (`ensure_utc`, crates/common/src/utils.rs), in bunvex's name. */
export const TZ_NOT_UTC = "TZ is set, but bunvex requires UTC. Unset TZ to continue.";

/**
 * Convex's `ensure_utc` (crates/common/src/utils.rs, called as its function runner starts, isolate/src/client.rs):
 * a function's `Date` is UTC whatever the machine's time zone (`new Date(0).toString()` reads `… GMT+0000
 * (Coordinated Universal Time)`), as this process's is once `TZ` is set (a pushed context's `Date` follows the
 * process's); `TZ` set to anything else, empty included, refuses the start.
 */
function useUtc(env: LocalBackendIo["env"]) {
  if (env.TZ !== undefined && env.TZ !== "UTC") throw new Error(TZ_NOT_UTC);
  process.env.TZ = "UTC";
}

export type RunningLocalBackend = { url: string; siteUrl: string | null; stop: () => Promise<void> };

/** Start the backend (the program waits on it; tests and `bunvex dev` stop it). */
export async function startLocalBackend(f: LocalBackendFlags, io: LocalBackendIo): Promise<RunningLocalBackend> {
  const refused = localBackendFlagsError(f);
  if (refused) throw new Error(refused);
  useUtc(io.env);
  // The executor (AD-44), checked before the store opens: the flag, else the environment, else `vm`.
  const sandbox = functionSandboxConfig(
    f.functionSandbox ?? io.env.BUNVEX_FUNCTION_SANDBOX,
    io.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION,
  );
  // Its executor is the entry point's to provide (`bin/local-backend.ts`): without it, fail before the store opens.
  if (sandbox.sandbox === "process") requireProcessExecutor();
  let persistence: Persistence;
  if (f.db === "sqlite") {
    const { SqlitePersistence } = await import("@bunvex/core/persistence/sqlite");
    persistence = new SqlitePersistence(resolve(io.cwd, f.dbSpec), { durable: true });
  } else
    persistence = await openPersistence({
      kind: f.db,
      url: f.dbSpec,
      requireSsl: !f.doNotRequireSsl,
      instanceName: f.instanceName,
      ...localBackendDatabaseEnv(f.db, io.env),
    });
  // The engine is read when a store first writes to S3 (its prefix is an instance setting), after it exists.
  const storage = (useCase: "files" | "modules" | "exports" | "snapshot_imports" | "search") => {
    // With --s3-storage, each use case whose bucket is set is in S3, the others stay local (STUDY-38 K4).
    if (!f.s3 || !s3OptionsFromEnv(io.env, useCase))
      return new LocalBlobStore(resolve(io.cwd, f.localStorage), useCase);
    return blobStoreFromEnv(io.env, {
      useCase,
      // Recorded in `_db` at the start (below), before any store is used.
      s3Prefix: async () => (storageType as { s3Prefix: string }).s3Prefix,
    });
  };
  // Search and vector index segments live in the `search` use case (STUDY-111); its store is made once the engine
  // exists.
  let searchBlobs: BlobStore | null = null;
  const engine: Engine = new Engine(defineSchema({}), persistence, {
    instanceName: f.instanceName,
    instanceSecret: f.instanceSecret,
    storedSchema: true,
    lease: { ttlMs: Number(io.env.LEASE_TTL_MS ?? 5000), waitMs: Number(io.env.LEASE_WAIT_MS ?? 0) },
    // Segments read from disk: the local store's files, or a local cache of S3's (STUDY-111 PR 9).
    searchCacheDir: resolve(io.cwd, f.localStorage, "search_cache"),
    searchStorage: searchSegmentStore(() => {
      searchBlobs ??= storage("search");
      return searchBlobs;
    }),
  });
  await engine.init();
  // The storage this start uses, checked against the store's (Convex's `initialize_storage_tag`, STUDY-126):
  // `--s3-storage` is S3, else the local directory as given.
  let storageType: StorageType;
  try {
    storageType = await engine.initializeStorage(f.s3 ? { tag: "s3" } : { tag: "local", dir: f.localStorage });
  } catch (e) {
    await engine.close();
    throw e;
  }
  const app = createServer({
    engine,
    functions: new Functions(engine),
    port: f.port,
    sitePort: f.sitePort,
    hostname: f.hostname,
    ...(f.cloudOrigin ? { cloudOrigin: f.cloudOrigin, siteOrigin: f.siteOrigin } : {}),
    ...(f.redact ? { redactLogsToClient: true } : {}),
    // A flag only, as Convex's: not BUNVEX_HTTP_PROXY.
    httpProxy: f.httpProxy ?? null,
    denyAddresses: f.denyAddresses ?? DEFAULT_ADDRESS_SCREEN,
    functionSandbox: sandbox.sandbox,
    functionSandboxIsolation: sandbox.isolation,
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

/** `keygen admin-key`: the key on stdout, clap's message (exit 2), or Convex's `Error:` for a bad secret (exit 1). */
function keygenMain(args: string[], io: LocalBackendIo): number {
  const out = (text: string) => {
    io.out(text);
    return 0;
  };
  const fail = (text: string, code = 2) => {
    io.err(text);
    return code;
  };
  const helpOf = (rest: string[]) =>
    !rest.length
      ? out(KEYGEN_USAGE)
      : rest[0] === "admin-key"
        ? out(ADMIN_KEY_USAGE)
        : fail(
            errorText(`unrecognized subcommand '${rest[0]}'`, {
              usage: "Usage: bunvex-local-backend keygen <COMMAND>",
            }),
          );
  const k = parseCommand(KEYGEN, args);
  if (k.kind === "help") return helpOf([]);
  if (k.kind === "missing-subcommand") return fail(KEYGEN_USAGE);
  if (k.kind === "error") return fail(k.text);
  if (k.kind !== "subcommand") return 2;
  if (k.name === "help") return helpOf(k.rest);
  const r = parseCommand(ADMIN_KEY, k.rest, fromEnv(io.env));
  if (r.kind === "help") return out(ADMIN_KEY_USAGE);
  if (r.kind === "error") return fail(r.text);
  if (r.kind !== "ok") return 2;
  const name = r.values.get("instance-name") as string;
  const secret = (r.values.get("instance-secret") as string | undefined) ?? secretFromEnv(io.env)!;
  const bad = instanceSecretError(secret);
  if (bad) return fail(`Error: ${bad}`, 1);
  return out(issueAdminKey({ instanceName: name, cipherKey: adminKeyCipherKey(secret) }));
}

/** The program: `keygen admin-key`, or the backend until SIGINT / SIGTERM. Resolves to the exit code. */
export async function localBackendMain(args: string[], io: LocalBackendIo, version: string): Promise<number> {
  const r = parseCommand(LOCAL_BACKEND, args, fromEnv(io.env));
  if (r.kind === "subcommand" && r.name === "keygen") return keygenMain(r.rest, io);
  if (r.kind === "subcommand") {
    // `help`, `help keygen`, `help keygen admin-key`.
    if (r.rest[0] === "keygen") return keygenMain(["help", ...r.rest.slice(1)], io);
    if (r.rest.length) {
      io.err(
        errorText(`unrecognized subcommand '${r.rest[0]}'`, {
          usage: "Usage: bunvex-local-backend [OPTIONS] [DB_SPEC] [COMMAND]",
        }),
      );
      return 2;
    }
  }
  if (r.kind === "help" || r.kind === "subcommand") {
    io.out(LOCAL_BACKEND_USAGE);
    return 0;
  }
  if (r.kind === "version") {
    io.out(`bunvex-local-backend ${version}`);
    return 0;
  }
  // Read once: what the backend starts (an external package's `bun install`, STUDY-148) never inherits it.
  const env = { ...io.env };
  delete io.env[INSTANCE_SECRET_ENV];
  if (r.kind !== "ok") {
    io.err(r.kind === "error" ? r.text : LOCAL_BACKEND_USAGE);
    return 2;
  }
  const flags = flagsOf(r.values, r.positional, env);
  let running: RunningLocalBackend;
  try {
    running = await startLocalBackend(flags, io);
  } catch (e) {
    // As Convex's `main`, whose errors end it this way.
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
  io.err(`bunvex-local-backend ${version}: instance ${flags.instanceName}, ${flags.db}`);
  io.err(`the API at ${running.url}${running.siteUrl ? `, HTTP actions at ${running.siteUrl}` : ""}`);
  // Convex warns the same way (a release build without `--convex-http-proxy`).
  if (!flags.httpProxy && (flags.denyAddresses ?? DEFAULT_ADDRESS_SCREEN) === "none") io.err(NO_PROXY_WARNING);
  await new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        io.err("bunvex-local-backend: stopping");
        void running.stop().then(done, done);
      });
  });
  return 0;
}
