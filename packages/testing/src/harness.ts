// `bunvexTest` (STUDY-159): convex-test's API on bunvex's real engine. Each test object is a deployment of its own
// inside the test's process:
//
// - an engine on memory persistence and a virtual clock (`TestRuntime`), with a server that is never reached over
//   the network for function calls;
// - the app pushed as `bunvex deploy` pushes it (the CLI's bundle, `start_push`, `wait_for_schema`, `finish_push`),
//   so its functions run as on a deployment: the import phase, the deployment's env, `"use node"`, components;
// - `t.query` / `t.mutation` / `t.action` call a function by reference, or run an inline one in the test's realm, as
//   convex-test does; internal functions may be called;
// - scheduled functions run on the virtual clock: `finishAllScheduledFunctions` moves it to each next job.
//
// It behaves as the real backend, not as convex-test's mock (DV-540): OCC, Convex's limits, real ids and storage
// URLs, deterministic `Date` and `Math.random`. Functions see the env given to `bunvexTest` (DV-541, AD-34).

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleProject, pushRequest } from "@bunvex/cli/push-request";
import { CRON_JOBS_TABLE, defineSchema, Engine, resolveComponentPath, SCHEDULED_JOBS_TABLE } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
import { MemoryBlobStore } from "@bunvex/file-storage";
import {
  adminKeyCipherKey,
  callerOf,
  componentFunctionName,
  componentsGeneric,
  createServer,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  Functions,
  getFunctionAddress,
  internalAction,
  internalMutation,
  internalQuery,
  issueAdminKey,
} from "@bunvex/server";
import { fromJsonValue, toJsonValue, type Value } from "@bunvex/values";

const INSTANCE_NAME = "bunvex-test";
const INSTANCE_SECRET = "7e57".repeat(16);
/** The test deployment's admin key: `t.fetch` acts as `withIdentity`'s user with it. */
const ADMIN_KEY = issueAdminKey({ instanceName: INSTANCE_NAME, cipherKey: adminKeyCipherKey(INSTANCE_SECRET) });
/** convex-test's default issuer, in bunvex's words (rule 5, DV-538). */
const TEST_ISSUER = "https://bunvex.test";
/** A reference to a child component's function, as `components.<name>` gives it. */
const CHILD_REFERENCE = "_reference/childComponent/";
/** The module inline functions are registered under: a name no pushed module can have. */
const INLINE_MODULE = "_bunvexTest";

export type BunvexTestOptions = {
  /** The project's directory (its `bunvex.json` and functions directory); default `process.cwd()`. */
  cwd?: string;
  /** The deployment's environment variables, as the dashboard or `bunvex env set` would set them (AD-34). */
  env?: Record<string, string>;
};

// biome-ignore lint/suspicious/noExplicitAny: a function reference of any shape, as convex-test's `FunctionReference<…, any>`
type AnyReference = any;
// biome-ignore lint/suspicious/noExplicitAny: an inline function's ctx, typed by the caller
type InlineFn<Ctx = any, R = unknown> = (ctx: Ctx) => R | Promise<R>;
type Identity = Record<string, unknown>;

/** A job as `_scheduled_jobs` stores it: its state, and when it runs next (ns) while pending or running. */
type Job = { state: { type: string }; nextTs: bigint | null };
/** When a job runs next, in ms. */
const nextMs = (j: Job) => Number((j.nextTs ?? 0n) / 1_000_000n);

/** One test deployment: the engine, its server and its virtual clock, set up on first use. */
class Backend {
  readonly runtime = new TestRuntime({ now: Date.now() });
  private ready: Promise<{ functions: Functions; engine: Engine; siteUrl: string; stop: () => Promise<void> }> | null =
    null;
  private inline = 0;
  /** Components a package's own tests mount (`registerComponent`): name and definition file. */
  readonly registered: [string, string][] = [];
  private tmp: string | null = null;

  constructor(private readonly opts: BunvexTestOptions) {}

  /**
   * The project to push: the one at `cwd`, or, with registered components, an app of its own that mounts each of
   * them (`app.use(definition, { name })`), written to a temporary directory.
   */
  private project(): string {
    if (!this.registered.length) return this.opts.cwd ?? process.cwd();
    this.tmp = mkdtempSync(join(tmpdir(), "bunvex-test-"));
    const imports = this.registered.map(([, file], i) => `import c${i} from ${JSON.stringify(file)};`).join("\n");
    const uses = this.registered.map(([name], i) => `app.use(c${i}, { name: ${JSON.stringify(name)} });`).join("\n");
    mkdirSync(join(this.tmp, "bunvex"));
    writeFileSync(
      join(this.tmp, "bunvex", "bunvex.config.ts"),
      `import { defineApp } from "@bunvex/server";\n${imports}\nconst app = defineApp();\n${uses}\nexport default app;\n`,
    );
    return this.tmp;
  }

  start() {
    this.ready ??= this.boot();
    return this.ready;
  }

  get started(): boolean {
    return this.ready !== null;
  }

  private async boot() {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
      instanceName: INSTANCE_NAME,
      instanceSecret: INSTANCE_SECRET,
      storedSchema: true,
      runtime: this.runtime,
    }).init();
    const functions = new Functions(engine);
    const server = createServer({
      engine,
      functions,
      port: 0,
      hostname: "127.0.0.1",
      deployable: true,
      moduleStorage: new MemoryBlobStore(),
      fileStorage: new MemoryBlobStore(),
      // In memory too, so a test leaves nothing in its working directory.
      exportStorage: new MemoryBlobStore(),
      importStorage: new MemoryBlobStore(),
    });
    const stop = async () => {
      await server.stop();
      await engine.close();
    };
    try {
      const env = Object.entries(this.opts.env ?? {});
      if (env.length)
        await engine.mutation((db) =>
          engine.environment.update(
            db,
            env.map(([name, value]) => ({ name, value })),
          ),
        );
      const bundled = await bundleProject(this.project());
      const start = (await server.push.startPush(pushRequest(bundled, bundled.bundled.modules, []) as never)) as {
        schemaChange: Parameters<typeof server.push.waitForSchema>[0]["schemaChange"];
      };
      for (;;) {
        const s = (await server.push.waitForSchema({ schemaChange: start.schemaChange, timeoutMs: 10_000 })) as {
          type: string;
          error?: string;
        };
        if (s.type === "complete") break;
        if (s.type === "failed") throw new Error(`bunvexTest: the schema failed to validate: ${s.error}`);
      }
      await server.push.finishPush({ startPush: start as never, dryRun: false });
    } catch (e) {
      await stop();
      throw e;
    }
    return { functions, engine, siteUrl: server.siteUrl ?? "", stop };
  }

  /** Register an inline function under a fresh name, for one call. */
  async registerInline(kind: "query" | "mutation" | "action", fn: InlineFn): Promise<string> {
    const { functions } = await this.start();
    const name = `f${++this.inline}`;
    const builder = kind === "query" ? internalQuery : kind === "mutation" ? internalMutation : internalAction;
    functions.register(INLINE_MODULE, { [name]: builder({ args: {}, handler: (ctx: unknown) => fn(ctx) }) as never });
    return `${INLINE_MODULE}:${name}`;
  }

  /** Every scheduled job: the app's and each component's (each lives in its caller's namespace, STUDY-157). */
  async jobs(): Promise<Job[]> {
    const { engine } = await this.start();
    const namespaces = [
      null,
      ...[...engine.catalog.components].filter(([, c]) => c.tables.has(SCHEDULED_JOBS_TABLE)).map(([id]) => id),
    ];
    return (await engine.query(async (db) => {
      const out: unknown[] = [];
      for (const ns of namespaces)
        out.push(...(await db.asSystem(() => db.inComponent(ns, () => db.query(SCHEDULED_JOBS_TABLE).collect()))));
      return out;
    })) as Job[];
  }

  /** A component's function by its reference (`components.<name>.<module>.<fn>`): its registry name. */
  async componentFunction(reference: string): Promise<string> {
    const { engine } = await this.start();
    const parts = reference.slice(CHILD_REFERENCE.length).split("/");
    const [component, ...path] = parts;
    const fn = path.pop();
    const found = await engine.query((db) => resolveComponentPath(db, [component!]));
    if (!found || !fn || !path.length) throw new Error(`bunvexTest: no component function ${reference}`);
    return componentFunctionName(found._id, `${path.join("/")}:${fn}`);
  }

  /** A cron job's function and arguments, by its name in `crons.ts`. */
  async cron(name: string): Promise<{ udfPath: string; args: Record<string, unknown> }> {
    const { engine } = await this.start();
    const rows = (await engine.query((db) => db.asSystem(() => db.query(CRON_JOBS_TABLE).collect()))) as unknown as {
      name: string;
      cronSpec: { udfPath: string; udfArgs: ArrayBuffer };
    }[];
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`bunvexTest: no cron job named ${JSON.stringify(name)}`);
    const [args] = fromJsonValue(JSON.parse(new TextDecoder().decode(row.cronSpec.udfArgs))) as [
      Record<string, unknown>,
    ];
    return { udfPath: row.cronSpec.udfPath, args: args ?? {} };
  }

  async close() {
    if (!this.ready) return;
    const r = await this.ready.catch(() => null);
    this.ready = null;
    await r?.stop();
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }
}

/** Wait for what the jobs started to settle: no job in progress, none due now. Real time, as real work runs. */
async function settleJobs(b: Backend, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await b.runtime.advance(0);
    const now = b.runtime.now();
    const busy = (await b.jobs()).some(
      (j) => j.state.type === "inProgress" || (j.state.type === "pending" && nextMs(j) <= now),
    );
    if (!busy) return;
    if (performance.now() > deadline) throw new Error("bunvexTest: scheduled functions still running");
    await Bun.sleep(1);
  }
}

/**
 * A function's result as a client receives it, as convex-test returns it: through the value JSON, so `undefined` is
 * `null`, an object's `undefined` fields are gone, and nothing the caller holds is the function's own object.
 */
const asReceived = (result: unknown): unknown => fromJsonValue(toJsonValue((result ?? null) as Value));

/** A test's view of its deployment, as convex-test's `TestConvex`, with an identity or none. */
export class TestBunvex {
  constructor(
    private readonly backend: Backend,
    private readonly identity: Identity | null = null,
    private readonly request: { ip?: string; userAgent?: string } | null = null,
  ) {}

  private async call(kind: "query" | "mutation" | "action", ref: AnyReference, args: unknown) {
    const { functions } = await this.backend.start();
    const name = typeof ref === "function" ? await this.backend.registerInline(kind, ref) : await this.nameOf(ref);
    const caller = {
      ...callerOf(this.identity as never),
      ...(this.request && {
        request: {
          ip: this.request.ip ?? null,
          userAgent: this.request.userAgent ?? null,
          requestId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
          authToken: null,
          scheduledFunctionId: null,
        },
      }),
    };
    const a = typeof ref === "function" ? {} : (args ?? {});
    const result =
      kind === "query"
        ? await functions.runQuery(name, a, false, caller)
        : kind === "mutation"
          ? await functions.runMutation(name, a, false, caller)
          : await functions.runAction(name, a, caller, { internal: true });
    return asReceived(result);
  }

  /** A reference's function: the app's by name, or a component's (`components.<name>.<module>.<fn>`). */
  private async nameOf(ref: AnyReference): Promise<string> {
    const address = getFunctionAddress(ref) as { name?: string; reference?: string };
    if (address.name !== undefined) return address.name;
    if (address.reference?.startsWith(CHILD_REFERENCE)) return this.backend.componentFunction(address.reference);
    throw new Error(`bunvexTest: not a function reference: ${String(ref)}`);
  }

  /** Run a query by reference, or an inline `(ctx) => …` as a query. Internal functions may be called. */
  // biome-ignore lint/suspicious/noExplicitAny: the result's type is the caller's
  query<F extends FunctionReference<"query", "public" | "internal">>(
    ref: F,
    ...args: Record<string, never> extends FunctionArgs<F> ? [args?: FunctionArgs<F>] : [args: FunctionArgs<F>]
  ): Promise<FunctionReturnType<F>>;
  query<R>(fn: InlineFn<any, R>): Promise<R>;
  query(ref: AnyReference, args?: unknown): Promise<unknown> {
    return this.call("query", ref, args);
  }

  /** Run a mutation by reference, or an inline `(ctx) => …` as a mutation. */
  // biome-ignore lint/suspicious/noExplicitAny: the result's type is the caller's
  mutation<F extends FunctionReference<"mutation", "public" | "internal">>(
    ref: F,
    ...args: Record<string, never> extends FunctionArgs<F> ? [args?: FunctionArgs<F>] : [args: FunctionArgs<F>]
  ): Promise<FunctionReturnType<F>>;
  mutation<R>(fn: InlineFn<any, R>): Promise<R>;
  mutation(ref: AnyReference, args?: unknown): Promise<unknown> {
    return this.call("mutation", ref, args);
  }

  /** Run an action by reference, or an inline `(ctx) => …` as an action. */
  // biome-ignore lint/suspicious/noExplicitAny: the result's type is the caller's
  action<F extends FunctionReference<"action", "public" | "internal">>(
    ref: F,
    ...args: Record<string, never> extends FunctionArgs<F> ? [args?: FunctionArgs<F>] : [args: FunctionArgs<F>]
  ): Promise<FunctionReturnType<F>>;
  action<R>(fn: InlineFn<any, R>): Promise<R>;
  action(ref: AnyReference, args?: unknown): Promise<unknown> {
    return this.call("action", ref, args);
  }

  /** convex-test's `t.run`: an inline function in a mutation, to set up or read data directly. */
  // biome-ignore lint/suspicious/noExplicitAny: the inline function's ctx, typed by the caller
  run<R>(fn: InlineFn<any, R>): Promise<R> {
    return this.call("mutation", fn, {}) as Promise<R>;
  }

  /**
   * The same deployment, calling as a user: `subject`, `issuer` and `tokenIdentifier` filled in as convex-test does
   * (the issuer `https://bunvex.test`).
   */
  withIdentity(identity: Identity): TestBunvex {
    const subject = (identity.subject as string | undefined) ?? defaultSubject(identity);
    const issuer = (identity.issuer as string | undefined) ?? TEST_ISSUER;
    const full = { ...identity, subject, issuer, tokenIdentifier: identity.tokenIdentifier ?? `${issuer}|${subject}` };
    return new TestBunvex(this.backend, full, this.request);
  }

  /** The same deployment, calling with a client's address and user agent (`ctx.meta.getRequestMetadata()`). */
  withRequestMetadata(request: { ip?: string; userAgent?: string }): TestBunvex {
    return new TestBunvex(this.backend, this.identity, request);
  }

  /**
   * convex-test's `t.fetch`: a request to the app's HTTP actions (`http.ts`), `path` starting with `/`. With
   * `withIdentity`, the action runs as that user (an admin key acting as the user, as the dashboard's runner does);
   * a request's own `Authorization` header wins.
   */
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith("/")) throw new Error(`bunvexTest: the path must start with "/": ${path}`);
    const { siteUrl } = await this.backend.start();
    const headers = new Headers(init?.headers);
    if (this.identity && !headers.has("authorization"))
      headers.set(
        "authorization",
        `Bunvex ${ADMIN_KEY}:${Buffer.from(JSON.stringify(this.identity)).toString("base64")}`,
      );
    return fetch(`${siteUrl}${path}`, { ...init, headers });
  }

  /**
   * Set (or, with null, remove) one of the deployment's environment variables, as `bunvex env set` does (AD-34): the
   * functions that read it see the new value from their next run.
   */
  async setEnv(name: string, value: string | null): Promise<void> {
    const { engine } = await this.backend.start();
    await engine.mutation((db) => engine.environment.update(db, [{ name, value }]));
  }

  /** The deployment's virtual clock (ms since the epoch); it moves only when scheduled functions are finished. */
  now(): number {
    return this.backend.runtime.now();
  }

  /**
   * Move the virtual clock `ms` forward, running the scheduled functions and crons due on the way, and wait for
   * them: what a convex-test test does with `vi.advanceTimersByTime(ms)` and `finishInProgressScheduledFunctions`.
   */
  async advanceTime(ms: number): Promise<void> {
    await this.backend.start();
    await settleJobs(this.backend);
    await this.backend.runtime.advance(ms);
    await settleJobs(this.backend);
  }

  /** Wait for the scheduled functions in progress to finish, without moving the clock. */
  async finishInProgressScheduledFunctions(): Promise<void> {
    await this.backend.start();
    await settleJobs(this.backend);
  }

  /**
   * Run every scheduled function, moving the virtual clock to each next one, including those they schedule, until
   * none is left. `advanceTimers` (e.g. `vi.runAllTimers`) is called on each step, for the test's own timers.
   */
  async finishAllScheduledFunctions(advanceTimers?: () => void, maxIterations = 100): Promise<void> {
    await this.backend.start();
    for (let i = 0; i < maxIterations; i++) {
      advanceTimers?.();
      await settleJobs(this.backend);
      const pending = (await this.backend.jobs()).filter((j) => j.state.type === "pending");
      if (!pending.length) return;
      const next = Math.min(...pending.map(nextMs));
      await this.backend.runtime.advance(Math.max(0, next - this.backend.runtime.now()));
    }
    throw new Error(
      `bunvexTest: scheduled functions still pending after ${maxIterations} iterations (one that keeps scheduling itself?)`,
    );
  }

  /**
   * Run a cron job of `crons.ts` now, by its name, as the cron executor runs it: its function with its arguments and
   * no identity (AD-35). Due crons also run as `finishAllScheduledFunctions` moves the clock.
   */
  async runCron(name: string): Promise<unknown> {
    const { functions } = await this.backend.start();
    const { udfPath, args } = await this.backend.cron(name);
    const caller = callerOf(null);
    return functions.kindOf(udfPath) === "action"
      ? functions.runAction(udfPath, args, caller, { internal: true })
      : functions.runMutation(udfPath, args, false, caller);
  }

  /**
   * convex-test's `registerComponent`, for a component package's own tests: mount the component whose definition
   * is `definition` (its `bunvex.config.ts`, or the directory holding it) as `name`, in an app of the test's own;
   * call it before the first call. Its functions are called through the reference this returns
   * (`componentsGeneric()[name]`). A project with an app of its own mounts its components in its `bunvex.config.ts`.
   */
  registerComponent(name: string, definition: string): AnyReference {
    if (this.backend.started) throw new Error("bunvexTest: registerComponent must come before the first call");
    const file = statSync(definition).isDirectory() ? join(definition, "bunvex.config.ts") : definition;
    this.backend.registered.push([name, resolve(file)]);
    return (componentsGeneric() as Record<string, unknown>)[name];
  }

  /** Stop the deployment. A test that ends without it leaves nothing that keeps the process alive. */
  close(): Promise<void> {
    return this.backend.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** A stable subject for an identity without one, as convex-test derives one from the identity's fields. */
function defaultSubject(identity: Identity): string {
  const h = new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex");
  return h.slice(0, 32);
}

/**
 * A test deployment of the project at `opts.cwd` (default: the working directory), as convex-test's `convexTest`.
 * The app is pushed on the first call. convex-test's `(schema, modules)` arguments are accepted and not needed: the
 * schema and the functions are the project's own, found as `bunvex deploy` finds them.
 */
export function bunvexTest(schemaOrOptions?: unknown, _modules?: unknown): TestBunvex {
  const opts =
    schemaOrOptions && typeof schemaOrOptions === "object" && !("tables" in schemaOrOptions)
      ? (schemaOrOptions as BunvexTestOptions)
      : {};
  return new TestBunvex(new Backend(opts));
}
