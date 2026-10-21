// The `process` executor (STUDY-171 §8, AD-44): a push's code loaded and run in a child of its own.
//
// - **One child per code version** (STUDY-171 §8.6). A load starts a child and loads the push in it; the version's
//   functions are stand-ins (`FunctionDef`s the engine runs as any other) whose calls go to that child. A child that
//   dies is replaced at the version's next call (its in-flight calls fail as a system error, Convex's internal
//   error). A version is retired when another one is installed, and its child stopped once its last call ends; one
//   that is never installed (a failed push) is stopped then too, or when it is collected. The pool of one-call
//   processes is STUDY-168's PR 9.
// - **Actions** (STUDY-171 §12) run in the version's child too: the stand-in is the action's handler, and the
//   engine runs it as any action (`HostActionCall`). Rooms (AD-42) are stand-ins whose gates run in the child.
// - **HTTP actions** (STUDY-168 PR 6): the router is a stand-in made from the routes the child analyzed, each route's
//   handler running the app's in the child (`HostActionCall.runHttp`), so the server routes, logs and answers a
//   request as in-process. The version's child stays in use until the response's body has been handed over.
// - **Push-time evaluations** (the auth config, a schema) run in one child kept for them.
// - **Not available yet** (STUDY-171 §8.7): `"use node"` actions fail when called, components fail the push, each
//   with a message that names the sandbox.

import { existsSync } from "node:fs";
import { pausingUserTime } from "@bunvex/core";
import {
  type AnyRoomDef,
  Crons,
  type DefaultExportUse,
  type EvaluateOptions,
  type Executor,
  ExecutorFailure,
  type FunctionDef,
  HttpRouter,
  httpActionGeneric,
  InvalidModulesError,
  type LoadedCode,
  type LoadOptions,
  type ModuleSource,
  moduleHash,
  NODE_FUNCTIONS,
  presenceGeneric,
  REMOTE_FUNCTIONS,
  REMOTE_GATES,
  roomGeneric,
  type SandboxCall,
  sandboxNotYet,
} from "@bunvex/server/executor";
import { validatorFromJson } from "@bunvex/values";
import { CHILD_ENTRY, type ChildLoad, SandboxError, SandboxProcess, type SandboxProcessOptions } from "./host.ts";
import { HostActionCall } from "./host-action.ts";
import { HostCall } from "./host-call.ts";
import type { WireRoom } from "./protocol.ts";
import type { RemoteFunction } from "./version.ts";

/** A version's child, replaced when it dies. */
class VersionChild {
  private current: Promise<{ child: SandboxProcess; load: ChildLoad }> | null;
  constructor(
    first: { child: SandboxProcess; load: ChildLoad },
    private readonly sources: ModuleSource[],
    private readonly opts: LoadOptions,
    private readonly spawn: SandboxProcessOptions,
  ) {
    this.current = Promise.resolve(first);
  }

  async get(): Promise<{ child: SandboxProcess; load: ChildLoad }> {
    const now = await this.current!;
    if (!now.child.failure) return now;
    this.current = (async () => {
      const child = await SandboxProcess.start(this.spawn);
      try {
        return { child, load: await child.load(this.sources, this.opts) };
      } catch (e) {
        await child.close();
        throw new ExecutorFailure(`the function sandbox could not load the code again: ${(e as Error).message}`);
      }
    })();
    return this.current;
  }

  async close() {
    const now = await this.current?.catch(() => null);
    await now?.child.close();
  }
}

export class RemoteCodeVersion implements LoadedCode {
  readonly functions = new Map<string, FunctionDef>();
  readonly rooms = new Map<string, AnyRoomDef>();
  readonly moduleHashes: Map<string, string>;
  readonly moduleLoads: Map<string, string[]>;
  readonly analysis: LoadedCode["analysis"];
  readonly modules: LoadedCode["modules"];
  readonly router: HttpRouter | undefined;
  readonly crons: LoadedCode["crons"];
  /** Calls in flight; once retired, the child stops when they end. */
  private inFlight = 0;
  private retired = false;

  constructor(
    private readonly child: VersionChild,
    sources: ModuleSource[],
    load: ChildLoad,
  ) {
    this.moduleHashes = load.moduleHashes;
    this.moduleLoads = load.moduleLoads;
    this.analysis = load.analysis;
    this.modules = new Map(sources.map((s) => [s.path, { source: s, hash: moduleHash(s) }]));
    for (const [key, f] of load.functions) this.functions.set(key, this.standIn(key, f));
    for (const [key, r] of load.rooms) this.rooms.set(key, this.roomStandIn(key, r));
    this.router = this.routerOf(load.analysis["http.js"]?.httpRoutes ?? null);
    this.crons = cronsOf(load.analysis["crons.js"]?.cronSpecs ?? null);
  }

  private standIn(key: string, f: RemoteFunction): FunctionDef {
    const args = f.args === null ? undefined : validatorFromJson(JSON.parse(f.args));
    const returns = f.returns === null ? undefined : validatorFromJson(JSON.parse(f.returns));
    const def = {
      kind: f.kind,
      visibility: f.visibility,
      // An action's handler is the engine's to call (`runAction`): the stand-in runs it in the child. A query's or
      // mutation's goes through `REMOTE_FUNCTIONS`.
      handler: f.node
        ? async () => {
            throw new Error(sandboxNotYet('"use node" actions'));
          }
        : (ctx: object, a: unknown) => this.action(key, ctx, a),
      ...(args ? { args } : {}),
      ...(returns ? { returns } : {}),
    } as FunctionDef;
    if (f.node) NODE_FUNCTIONS.add(def);
    if (f.kind !== "action")
      REMOTE_FUNCTIONS.set(def, (ctx, a, call) => this.call(key, f.kind as "query" | "mutation", ctx, a, call));
    return def;
  }

  /** A room or presence definition whose gates run in the child, as queries (`key#canJoin`). */
  private roomStandIn(key: string, r: WireRoom): AnyRoomDef {
    const validator = (json: string) => validatorFromJson(JSON.parse(json));
    const gate = (which: "canJoin" | "canPublish") => {
      const g = () => {
        throw new Error("a sandboxed room's gate runs in its child");
      };
      REMOTE_GATES.set(g, (ctx, a, call) => this.call(`${key}#${which}`, "query", ctx, a, call));
      return g;
    };
    const args = r.args === null ? undefined : validator(r.args);
    if (r.kind === "presence")
      return presenceGeneric({
        ...(args ? { args } : {}),
        ...(r.canJoin ? { canJoin: gate("canJoin") } : {}),
        state: validator(r.value),
      } as never) as unknown as AnyRoomDef;
    return roomGeneric({
      ...(args ? { args } : {}),
      ...(r.canJoin ? { canJoin: gate("canJoin") } : {}),
      ...(r.canPublish ? { canPublish: gate("canPublish") } : {}),
      presence: validator(r.value),
      events: Object.fromEntries(r.events.map(([name, v]) => [name, validator(v)])),
    } as never) as unknown as AnyRoomDef;
  }

  /** An action, run in the child: the engine already holds its permit, its timeout and its environment. */
  private async action(key: string, ctx: object, args: unknown) {
    this.inFlight++;
    try {
      let got: Awaited<ReturnType<VersionChild["get"]>>;
      try {
        got = await this.child.get();
      } catch (e) {
        throw e instanceof SandboxError ? new ExecutorFailure(e.message) : e;
      }
      return await new HostActionCall(got.child, ctx).run(key, got.load.versionId, args);
    } finally {
      if (--this.inFlight === 0 && this.retired) void this.child.close();
    }
  }

  private async call(key: string, kind: "query" | "mutation", ctx: object, args: unknown, call: SandboxCall) {
    this.inFlight++;
    try {
      // The engine's timer is paused while the child runs: the child counts its own user time, and every message
      // charges it (`HostCall.charge`), so the round trips, the host's work on each operation and a new child's
      // start are not user time.
      return await pausingUserTime(async () => {
        let got: Awaited<ReturnType<VersionChild["get"]>>;
        try {
          got = await this.child.get();
        } catch (e) {
          throw e instanceof SandboxError ? new ExecutorFailure(e.message) : e;
        }
        return new HostCall(got.child, kind, ctx as Record<string, unknown>, call).run(key, got.load.versionId, args);
      });
    } finally {
      if (--this.inFlight === 0 && this.retired) void this.child.close();
    }
  }

  /**
   * The router's stand-in: the analyzed routes, in the order the child's router gave them, each one's handler running
   * the app's in the child (the server looks a request up in it, as in the app's router in-process).
   */
  private routerOf(routes: LoadedCode["analysis"][string]["httpRoutes"]): HttpRouter | undefined {
    if (routes === null) return undefined;
    const router = new HttpRouter();
    for (const { route } of routes) {
      const method = route.method as Parameters<HttpRouter["route"]>[0]["method"];
      const key: [string, string] = [route.method, route.path];
      const handler = httpActionGeneric((ctx, request) => this.http(key, ctx, request) as Promise<Response>);
      if (route.path.endsWith("*")) router.route({ pathPrefix: route.path.slice(0, -1), method, handler });
      else router.route({ path: route.path, method, handler });
    }
    return router;
  }

  /**
   * An HTTP action, run in the child: the engine holds its permit, its timeout and its environment, as for an action.
   * The call is in flight until its response's body has been handed over.
   */
  private async http(route: [string, string], ctx: object, request: Request): Promise<Response | undefined> {
    this.inFlight++;
    let ended: Promise<void> = Promise.resolve();
    try {
      let got: Awaited<ReturnType<VersionChild["get"]>>;
      try {
        got = await this.child.get();
      } catch (e) {
        throw e instanceof SandboxError ? new ExecutorFailure(e.message) : e;
      }
      const outcome = await new HostActionCall(got.child, ctx).runHttp(route, got.load.versionId, request);
      ended = outcome.ended;
      return outcome.response;
    } finally {
      void ended.then(() => {
        if (--this.inFlight === 0 && this.retired) void this.child.close();
      });
    }
  }

  /** No more calls are expected: the child stops once the last one ends. */
  retire() {
    this.retired = true;
    if (this.inFlight === 0) void this.child.close();
  }
}

/** Stops a version's child once the version is collected, if nothing retired it before. */
const collected = new FinalizationRegistry<VersionChild>((child) => void child.close());

export class ProcessExecutor implements Executor {
  readonly kind = "process" as const;
  private readonly versions = new Set<WeakRef<RemoteCodeVersion>>();
  private evaluator: Promise<SandboxProcess> | null = null;

  /** `spawn`: how its children start (tests only: a child that misbehaves). */
  constructor(private readonly spawn: SandboxProcessOptions = {}) {}

  async load(sources: ModuleSource[], opts: LoadOptions): Promise<RemoteCodeVersion> {
    const child = await SandboxProcess.start(this.spawn);
    let load: ChildLoad;
    try {
      load = await child.load(sources, opts);
    } catch (e) {
      await child.close();
      throw e;
    }
    const vc = new VersionChild({ child, load }, sources, opts, this.spawn);
    const version = new RemoteCodeVersion(vc, sources, load);
    collected.register(version, vc);
    this.versions.add(new WeakRef(version));
    return version;
  }

  async evaluateDefault(source: ModuleSource, opts: EvaluateOptions, use: DefaultExportUse): Promise<unknown> {
    let child = await this.evaluator;
    if (!child || child.failure) {
      this.evaluator = SandboxProcess.start(this.spawn);
      child = await this.evaluator;
    }
    return child.evaluateDefault(source, opts, use);
  }

  release(version: LoadedCode) {
    if (version instanceof RemoteCodeVersion) version.retire();
  }

  /** `version` serves now: every other version this executor loaded is retired. */
  installed(version: LoadedCode) {
    for (const ref of this.versions) {
      const v = ref.deref();
      if (!v) this.versions.delete(ref);
      else if (v !== version) {
        v.retire();
        this.versions.delete(ref);
      }
    }
  }

  /** Stops every child. */
  async close() {
    for (const ref of this.versions) ref.deref()?.retire();
    this.versions.clear();
    const evaluator = await this.evaluator?.catch(() => null);
    await evaluator?.close();
  }
}

/**
 * The server's `process` executor (`provideProcessExecutor(createProcessExecutor)`). A compiled `bunvex-local-backend`
 * carries no child runtime on disk yet (STUDY-168 PR 9/11): it fails here, at start, never at a push.
 */
export function createProcessExecutor(): Executor {
  if (!existsSync(CHILD_ENTRY))
    throw new Error(
      `the function sandbox 'process' needs its child runtime (${CHILD_ENTRY}), which this executable does not carry ` +
        "yet: run bunvex-local-backend from its package, or unset BUNVEX_FUNCTION_SANDBOX",
    );
  return new ProcessExecutor();
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** The analyzed crons as the app's `Crons` held them, for the server to check and schedule again (`cronSpecs`). */
function cronsOf(specs: LoadedCode["analysis"][string]["cronSpecs"]): Crons | undefined {
  if (specs === null) return undefined;
  const crons = new Crons();
  for (const [id, spec] of Object.entries(specs)) {
    const s = spec.cronSchedule as Record<string, unknown> & { type: string };
    const schedule =
      s.type === "cron"
        ? { type: "cron", cron: s.cronExpr }
        : s.type === "weekly"
          ? { ...s, dayOfWeek: DAYS[s.dayOfWeek as number] }
          : s;
    crons.crons[id] = { name: spec.udfPath, args: spec.udfArgs as never, schedule: schedule as never };
  }
  return crons;
}
