// `bunvex start` (STUDY-37 PR 4, E1): run the self-hosted server, as Convex's `convex-local-backend` binary
// and its Docker scripts (crates/local_backend/src/config.rs, self-hosted/docker-build/*.sh) do:
//
// - the API on `--port` (3210) and HTTP actions on `--site-proxy-port` (3211), on `--interface`;
// - the public origins `--cloud-origin` / `--site-origin` (default `http://127.0.0.1:<port>`), which are the
//   built-in variables `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL`;
// - the instance name and secret: `--instance-name` / `--instance-secret` (they come together), else
//   INSTANCE_NAME / INSTANCE_SECRET, else the files `<data-dir>/credentials/instance_{name,secret}`, else
//   generated and saved there (Convex's `read_credentials.sh`);
// - the database from the environment as the server reads it (PERSISTENCE, POSTGRES_URL, MYSQL_URL, …),
//   else SQLite in the data directory; files and pushed code under `<data-dir>/storage`, or S3 from the
//   environment;
// - a deployable server: functions come from pushes (`bunvex deploy`).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_INSTANCE_NAME, defineSchema, Engine } from "@bunvex/core";
import {
  createServer,
  Functions,
  openPersistence,
  type PersistenceConfig,
  persistenceConfigFromEnv,
} from "@bunvex/server";
import type { Io } from "./io.ts";

export const START_USAGE = `Usage: bunvex start [options]

Run the self-hosted bunvex server. Functions are deployed to it with \`bunvex deploy\`.

Options:
  --port <n>                the API's port (default 3210)
  --site-proxy-port <n>     the HTTP actions' port (default: the API's + 1, 3211)
  --interface <addr>        the interface to listen on (default: all)
  --cloud-origin <url>      the API's public URL (default http://127.0.0.1:<port>)
  --site-origin <url>       the HTTP actions' public URL (default http://127.0.0.1:<site-proxy-port>)
  --instance-name <name>    with --instance-secret (default: INSTANCE_NAME, the credentials files, or ${DEFAULT_INSTANCE_NAME})
  --instance-secret <hex>   32 bytes, hex-encoded (default: INSTANCE_SECRET, the credentials files, or generated)
  --data-dir <dir>          where the data lives (default: DATA, else ./.data)
  --redact-logs-to-client   do not send functions' log lines and errors' details to clients

The database comes from the environment (PERSISTENCE=sqlite|postgres|mysql|mongodb, PERSISTENCE_URL,
POSTGRES_URL, MYSQL_URL, …); without one, SQLite in the data directory.`;

type Flags = {
  port: number;
  sitePort?: number;
  hostname?: string;
  cloudOrigin?: string;
  siteOrigin?: string;
  instanceName?: string;
  instanceSecret?: string;
  dataDir?: string;
  redact: boolean;
};

function parseFlags(args: string[]): Flags | string {
  const f: Flags = { port: 3210, redact: false };
  const valued = new Set([
    "--port",
    "--site-proxy-port",
    "--interface",
    "--cloud-origin",
    "--site-origin",
    "--instance-name",
    "--instance-secret",
    "--data-dir",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--redact-logs-to-client") f.redact = true;
    else if (valued.has(name)) {
      const v = inline ?? args[++i];
      if (!v) return `${name} needs a value`;
      if (name === "--port" || name === "--site-proxy-port") {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) return `${name} must be a port number, got '${v}'`;
        if (name === "--port") f.port = n;
        else f.sitePort = n;
      } else if (name === "--interface") f.hostname = v;
      else if (name === "--cloud-origin") f.cloudOrigin = v;
      else if (name === "--site-origin") f.siteOrigin = v;
      else if (name === "--instance-name") f.instanceName = v;
      else if (name === "--instance-secret") f.instanceSecret = v;
      else f.dataDir = v;
    } else return `unknown option ${a}`;
  }
  // As Convex's flags: the origins, and the name and secret, come in pairs.
  if (!!f.cloudOrigin !== !!f.siteOrigin) return "--cloud-origin and --site-origin go together";
  if (!!f.instanceName !== !!f.instanceSecret) return "--instance-name and --instance-secret go together";
  for (const o of [f.cloudOrigin, f.siteOrigin])
    if (o && !/^https?:\/\//.test(o)) return `Origin url should start with https:// or http:// but got '${o}'`;
  return f;
}

/** Convex's instance secret check: 32 bytes, hex-encoded. */
export function checkInstanceSecret(secret: string): string | null {
  if (!/^[0-9a-fA-F]*$/.test(secret) || secret.length % 2) return "--instance-secret must be hex-encoded";
  const n = secret.length / 2;
  return n === 32 ? null : `Hex-decoded key was ${n} bytes, not 32`;
}

/** The data directory: `--data-dir`, else DATA, else ./.data (the server's default). */
export const dataDirOf = (io: Io, flag?: string) => resolve(io.cwd, flag ?? io.env.DATA ?? "./.data");

/** The persistence `start` uses: the environment's, else SQLite in the data directory. */
export function startPersistence(env: Io["env"], dataDir: string): PersistenceConfig {
  const config = persistenceConfigFromEnv(env, () => {});
  const chosen = env.PERSISTENCE || env.POSTGRES_URL || env.MYSQL_URL || env.DATABASE_URL;
  return { ...config, kind: chosen ? config.kind : "sqlite", dataDir };
}

/** The credentials files Convex's Docker scripts keep in the data directory. */
export function readCredentials(dataDir: string): { name?: string; secret?: string } {
  const read = (f: string) => {
    const p = join(dataDir, "credentials", f);
    return existsSync(p) ? readFileSync(p, "utf8").trim() || undefined : undefined;
  };
  return { name: read("instance_name"), secret: read("instance_secret") };
}

/** Convex's `read_credentials.sh`: the env, else the files, else generated; saved to the files either way. */
export function credentials(io: Io, flags: { instanceName?: string; instanceSecret?: string }, dataDir: string) {
  const files = readCredentials(dataDir);
  const name = flags.instanceName ?? (io.env.INSTANCE_NAME || files.name || DEFAULT_INSTANCE_NAME);
  const secret = flags.instanceSecret ?? (io.env.INSTANCE_SECRET || files.secret || randomBytes(32).toString("hex"));
  const dir = join(dataDir, "credentials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instance_name"), `${name}\n`);
  writeFileSync(join(dir, "instance_secret"), `${secret}\n`, { mode: 0o600 });
  return { name, secret };
}

export type Started = { url: string; siteUrl: string | null; stop: () => Promise<void> };

/** Start the server (the command waits on it; tests stop it). */
export async function startServer(args: string[], io: Io): Promise<Started | number> {
  const flags = parseFlags(args);
  if (typeof flags === "string") {
    io.err(`bunvex start: ${flags}\n\n${START_USAGE}`);
    return 2;
  }
  const dataDir = dataDirOf(io, flags.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const { name, secret } = credentials(io, flags, dataDir);
  const bad = checkInstanceSecret(secret);
  if (bad) {
    io.err(`bunvex start: ${bad}`);
    return 1;
  }
  const config = startPersistence(io.env, dataDir);
  let engine: Engine;
  try {
    engine = await new Engine(defineSchema({}), await openPersistence(config), {
      instanceName: name,
      instanceSecret: secret,
      storedSchema: true,
      lease: { ttlMs: Number(io.env.LEASE_TTL_MS ?? 5000), waitMs: Number(io.env.LEASE_WAIT_MS ?? 0) },
    }).init();
  } catch (e) {
    io.err(`bunvex start: could not open the database: ${(e as Error).message}`);
    return 1;
  }
  // Files and pushed code under the data directory, unless the environment says otherwise: the server
  // reads its blob stores' places from the environment as it is created.
  const before = process.env.DATA;
  if (io.env.DATA === undefined) process.env.DATA = dataDir;
  let app: ReturnType<typeof createServer>;
  try {
    app = createServer({
      engine,
      functions: new Functions(engine),
      port: flags.port,
      ...(flags.hostname ? { hostname: flags.hostname } : {}),
      ...(flags.sitePort === undefined ? {} : { sitePort: flags.sitePort }),
      ...(flags.cloudOrigin ? { cloudOrigin: flags.cloudOrigin, siteOrigin: flags.siteOrigin } : {}),
      ...(flags.redact ? { redactLogsToClient: true } : {}),
      deployable: true,
      label: config.kind,
    });
  } finally {
    if (before === undefined) delete process.env.DATA;
    else process.env.DATA = before;
  }
  await app.codeReady.catch(() => {});
  const url = (flags.cloudOrigin ?? `http://127.0.0.1:${app.server.port}`).replace(/\/$/, "");
  io.err(
    `bunvex: instance ${name}, ${config.kind} in ${config.kind === "sqlite" ? dataDir : "the configured database"}`,
  );
  io.err(`bunvex: the API at ${url}${app.siteUrl ? `, HTTP actions at ${app.siteUrl}` : ""}`);
  io.err(
    `bunvex: an admin key for \`bunvex deploy\`: bunvex admin-key${flags.dataDir ? ` --data-dir ${flags.dataDir}` : ""}`,
  );
  return {
    url,
    siteUrl: app.siteUrl,
    stop: async () => {
      await app.shutdown();
      await engine.close();
    },
  };
}

export async function startCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(START_USAGE);
    return 0;
  }
  const started = await startServer(args, io);
  if (typeof started === "number") return started;
  await new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        io.err("bunvex: stopping");
        void started.stop().then(done, done);
      });
  });
  return 0;
}
