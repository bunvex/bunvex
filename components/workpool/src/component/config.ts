// The pool's config (STUDY-199 §1.6): `maxParallelism` and `logLevel` in the `globals` row, created with the defaults
// on first use and replaced only when a value given differs. `maxParallelism` is checked before anything is written:
// above 200 is refused, above 100 warned about, below 0 refused; 0 pauses the pool. Nothing checks it is an integer.
import { type MutationCtx, mutation } from "./_generated/server";
import { kickMainLoop } from "./kick";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging";
import { type Config, DEFAULT_MAX_PARALLELISM, vConfig } from "./shared";

export const MAX_POSSIBLE_PARALLELISM = 200;
export const MAX_PARALLELISM_SOFT_LIMIT = 100;

export const update = mutation({
  args: vConfig.partial(),
  handler: async (ctx, args) => {
    const { previous } = await readOrWriteGlobals(ctx, args);
    // A raise may let waiting jobs start.
    if (args.maxParallelism && args.maxParallelism > previous) await kickMainLoop(ctx, "kick");
  },
});

export function validateConfig(config: Partial<Config>): void {
  const n = config.maxParallelism;
  if (n === undefined) return;
  if (n > MAX_POSSIBLE_PARALLELISM) throw new Error(`maxParallelism must be <= ${MAX_POSSIBLE_PARALLELISM}`);
  if (n > MAX_PARALLELISM_SOFT_LIMIT) {
    createLogger(config.logLevel ?? DEFAULT_LOG_LEVEL).warn(
      `maxParallelism should be <= ${MAX_PARALLELISM_SOFT_LIMIT}, but is set to ${n}. This will be an error in a future version.`,
    );
  } else if (n < 0) {
    throw new Error("maxParallelism must be >= 0");
  }
}

/** The `globals` row, created or updated with `config` first. */
export async function getOrUpdateGlobals(ctx: MutationCtx, config?: Partial<Config>) {
  return (await readOrWriteGlobals(ctx, config)).globals;
}

async function readOrWriteGlobals(ctx: MutationCtx, config?: Partial<Config>) {
  if (config) validateConfig(config);
  const globals = await ctx.db.query("globals").unique();
  const previous = globals?.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
  if (!globals) {
    const id = await ctx.db.insert("globals", {
      maxParallelism: config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
      logLevel: config?.logLevel ?? DEFAULT_LOG_LEVEL,
    });
    return { globals: (await ctx.db.get("globals", id))!, previous };
  }
  if (config) {
    let changed = false;
    if (config.maxParallelism !== undefined && config.maxParallelism !== globals.maxParallelism) {
      globals.maxParallelism = config.maxParallelism;
      changed = true;
    }
    // An empty level is no level.
    if (config.logLevel && config.logLevel !== globals.logLevel) {
      globals.logLevel = config.logLevel;
      changed = true;
    }
    if (changed) await ctx.db.replace("globals", globals._id, globals);
  }
  return { globals, previous };
}
