// `bunvex admin-key` (STUDY-34, DV-160): print an admin key for this deployment, as Convex's self-hosted
// `generate_key` / `generate_admin_key.sh` do. The instance name and secret come from the flags, else
// INSTANCE_NAME / INSTANCE_SECRET, else the store itself (`_instance`, read at its latest commit without the
// lease, so it works while the server runs) — the secret may live only there (DV-07). A data directory holds
// them in `credentials/` as Convex's Docker scripts keep them (`read_credentials.sh`, STUDY-40 L2).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_INSTANCE_NAME, readInstanceRecord } from "@bunvex/core";
import { adminKeyCipherKey, issueAdminKey, openPersistence, persistenceConfigFromEnv } from "@bunvex/server";
import {
  argumentError,
  conflictingOptions,
  missingArgument,
  optionsIn,
  tooManyArguments,
  unknownOption,
} from "./args.ts";
import type { Io } from "./io.ts";

/** The data directory: `--data-dir`, else DATA, else ./.data. */
const dataDirOf = (io: Io, flag?: string) => resolve(io.cwd, flag ?? io.env.DATA ?? "./.data");

/** The credentials files Convex's Docker scripts keep in the data directory (`read_credentials.sh`). */
function readCredentials(dataDir: string): { name?: string; secret?: string } {
  const read = (f: string) => {
    const p = join(dataDir, "credentials", f);
    return existsSync(p) ? readFileSync(p, "utf8").trim() || undefined : undefined;
  };
  return { name: read("instance_name"), secret: read("instance_secret") };
}

export const ADMIN_KEY_USAGE = `Usage: bunvex admin-key [options]

Print an admin key for this deployment (on stdout; "Admin key:" on stderr).

Options:
  --read-only              a key that can only read data, logs and metrics
  --system                 a system key (every operation; cannot act as a user)
  --instance-name <name>   default: INSTANCE_NAME, else the one stored with the data
  --instance-secret <hex>  default: INSTANCE_SECRET, else the one stored with the data
  --data-dir <dir>         a data directory with credentials/ (as the Docker volume; default: DATA, else ./.data)

The store is the server's: PERSISTENCE, PERSISTENCE_URL (or POSTGRES_URL, MYSQL_URL), DATA.`;

type Flags = { readOnly: boolean; system: boolean; instanceName?: string; instanceSecret?: string; dataDir?: string };

function parseFlags(args: string[]): Flags | string {
  const f: Flags = { readOnly: false, system: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--read-only") f.readOnly = true;
    else if (name === "--system") f.system = true;
    else if (name === "--instance-name" || name === "--instance-secret" || name === "--data-dir") {
      const v = inline ?? args[++i];
      if (!v)
        return missingArgument(
          (
            {
              "--instance-name": "--instance-name <name>",
              "--instance-secret": "--instance-secret <hex>",
              "--data-dir": "--data-dir <dir>",
            } as Record<string, string>
          )[name]!,
        );
      if (name === "--instance-name") f.instanceName = v;
      else if (name === "--instance-secret") f.instanceSecret = v;
      else f.dataDir = v;
    } else if (a.startsWith("-")) return unknownOption(a, optionsIn(ADMIN_KEY_USAGE));
    else return tooManyArguments("admin-key", 0, args.filter((x) => !x.startsWith("-")).length);
  }
  if (f.readOnly && f.system) return conflictingOptions("--system", "--read-only");
  return f;
}

export async function adminKeyCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(ADMIN_KEY_USAGE);
    return 0;
  }
  const flags = parseFlags(args);
  // As every command's argument errors (STUDY-124); admin-key has no Convex counterpart, so no help after.
  if (typeof flags === "string") return argumentError(io, flags);
  const dataDir = dataDirOf(io, flags.dataDir);
  const files = readCredentials(dataDir);
  let name = flags.instanceName ?? (io.env.INSTANCE_NAME || files.name);
  let secret = flags.instanceSecret ?? (io.env.INSTANCE_SECRET || files.secret);
  if (name === undefined || secret === undefined) {
    let stored: Record<string, unknown> | null;
    try {
      const store = await openPersistence(persistenceConfigFromEnv(io.env, () => {}));
      try {
        stored = await readInstanceRecord(store);
      } finally {
        await store.close();
      }
    } catch (e) {
      io.err(`bunvex admin-key: could not read the store: ${(e as Error).message}`);
      return 1;
    }
    if (typeof stored?.instanceName === "string") name ??= stored.instanceName;
    if (typeof stored?.instanceSecret === "string") secret ??= stored.instanceSecret;
  }
  if (secret === undefined) {
    io.err(
      "bunvex admin-key: no instance secret: set INSTANCE_SECRET (or --instance-secret), or start the server once so it stores one",
    );
    return 1;
  }
  name ??= DEFAULT_INSTANCE_NAME;
  const key = issueAdminKey({
    instanceName: name,
    cipherKey: adminKeyCipherKey(secret),
    readOnly: flags.readOnly,
    system: flags.system,
  });
  io.err(flags.system ? "System key:" : flags.readOnly ? "Read-only admin key:" : "Admin key:");
  io.out(key);
  return 0;
}
