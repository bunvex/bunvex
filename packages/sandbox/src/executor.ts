// The `process` executor (STUDY-171 §8, AD-44): a push's code loaded and run in a child of its own.
//
// - **One child per code version** (STUDY-171 §8.6). A load starts a child and loads the push in it; the version's
//   functions are stand-ins (`FunctionDef`s the engine runs as any other) whose calls go to that child. A child that
//   dies is replaced at the version's next call (its in-flight calls fail as a system error, Convex's internal
//   error). A version is retired when another one is installed, and its child stopped once its last call ends; one
//   that is never installed (a failed push) is stopped then too, or when it is collected. The pool of one-call
//   processes is STUDY-168's PR 9.
// - **Components** (STUDY-168 PR 7, STUDY-171 §15): each instance's code is loaded beside the app's version, in its
//   child: a `CodeVersion` of its own there (its own contexts, its modules evaluated once, DV-492), each call naming
//   the version it runs (the namespace switch), as Convex runs a nested call into a component in the caller's isolate
//   in a context of its own. What a call reaches is its `ctx`'s, on the host: `resolveCall`, the namespace, the
//   component's variables. The server releases an instance's version when the instance gets another or goes; the
//   child forgets it (`unload`), and stops once it holds no version.
// - **Actions** (STUDY-171 §12) run in the version's child too: the stand-in is the action's handler, and the
//   engine runs it as any action (`HostActionCall`). Rooms (AD-42) are stand-ins whose gates run in the child.
// - **HTTP actions** (STUDY-168 PR 6): the router is a stand-in made from the routes the child analyzed, each route's
//   handler running the app's in the child (`HostActionCall.runHttp`), so the server routes, logs and answers a
//   request as in-process. The version's child stays in use until the response's body has been handed over.
// - **Push-time evaluations** (the auth config, a schema) run in one child kept for them.
// - **Not available yet** (STUDY-171 §8.7): `"use node"` actions fail when called, with a message that names the
//   sandbox.

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

/** A version's place in a child: its code, and the id its calls name it by there. */
type Slot = { sources: ModuleSource[]; opts: LoadOptions; versionId: number };

/**
 * A child and the versions loaded in it (STUDY-168 PR 7): the app's code version, and the component instances loaded
 * beside it, each its own `CodeVersion` (its own contexts, its modules evaluated once: DV-492), each call naming the
 * one it runs (the namespace switch). A child that dies is replaced at the next call of any of them, every version it
 * held loaded again in the new one, in the order they came. The child stops once its last version is dropped.
 */
class ChildHost {
  private current: Promise<SandboxProcess>;
  private readonly slots = new Set<Slot>();
  /** No version is left: the child is stopped, and no version may be added. */
  closed = false;
  /** How many versions the child said it held at its last load (the ones dropped forgotten). */
  held = 0;

  constructor(
    first: SandboxProcess,
    private readonly spawn: SandboxProcessOptions,
    private readonly onClosed: (host: ChildHost) => void = () => {},
  ) {
    this.current = Promise.resolve(first);
  }

  /** The child, alive: a new one, with every version loaded again, if it died. */
  private async child(): Promise<SandboxProcess> {
    const now = await this.current;
    if (!now.failure) return now;
    const replacing = (async () => {
      const child = await SandboxProcess.start(this.spawn);
      try {
        for (const slot of this.slots) {
          const load = await child.load(slot.sources, slot.opts);
          slot.versionId = load.versionId;
          this.held = load.held;
        }
        return child;
      } catch (e) {
        await child.close();
        throw new ExecutorFailure(`the function sandbox could not load the code again: ${(e as Error).message}`);
      }
    })();
    this.current = replacing;
    // A failed replacement is tried again at the next call.
    replacing.catch(() => {
      if (this.current === replacing) this.current = Promise.resolve(now);
    });
    return replacing;
  }

  /** Loads a version in this host's child: the version's place, and what the child made of it. */
  async add(sources: ModuleSource[], opts: LoadOptions): Promise<{ slot: Slot; load: ChildLoad }> {
    const child = await this.child();
    const load = await child.load(sources, opts);
    this.held = load.held;
    const slot: Slot = { sources, opts, versionId: load.versionId };
    if (this.closed) {
      // Every other version was dropped while this one loaded: the child is stopping.
      throw new ExecutorFailure("the function sandbox's process was stopped while the code loaded");
    }
    this.slots.add(slot);
    return { slot, load };
  }

  /** The child that runs `slot`'s calls, and the version's id there. */
  async get(slot: Slot): Promise<{ child: SandboxProcess; versionId: number }> {
    if (!this.slots.has(slot)) throw new ExecutorFailure("the function sandbox's code version was released");
    const child = await this.child();
    return { child, versionId: slot.versionId };
  }

  /** `slot` runs no more calls: the child forgets it, and stops once it holds none. */
  drop(slot: Slot) {
    if (!this.slots.delete(slot)) return;
    if (this.slots.size === 0) {
      this.closed = true;
      void this.close();
      return;
    }
    void this.current.then(
      (child) => {
        if (!child.failure) child.send({ t: "unload", version: slot.versionId });
      },
      () => {},
    );
  }

  /** How many versions the child holds (tests). */
  get size() {
    return this.slots.size;
  }

  /** The child's pid (tests, measurements). */
  async pid(): Promise<number> {
    return (await this.current).pid;
  }

  async close() {
    this.closed = true;
    this.slots.clear();
    this.onClosed(this);
    const now = await this.current.catch(() => null);
    await now?.close();
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
    /** The child this version runs in, and its place there. */
    readonly host: ChildHost,
    private readonly slot: Slot,
    sources: ModuleSource[],
    load: ChildLoad,
    /** Loaded beside another version (a component instance beside the app's): `installed` does not retire it. */
    readonly beside: boolean,
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
      const got = await this.childNow();
      return await new HostActionCall(got.child, ctx).run(key, got.versionId, args);
    } finally {
      if (--this.inFlight === 0 && this.retired) this.host.drop(this.slot);
    }
  }

  private async call(key: string, kind: "query" | "mutation", ctx: object, args: unknown, call: SandboxCall) {
    this.inFlight++;
    try {
      // The engine's timer is paused while the child runs: the child counts its own user time, and every message
      // charges it (`HostCall.charge`), so the round trips, the host's work on each operation and a new child's
      // start are not user time.
      return await pausingUserTime(async () => {
        const got = await this.childNow();
        return new HostCall(got.child, kind, ctx as Record<string, unknown>, call).run(key, got.versionId, args);
      });
    } finally {
      if (--this.inFlight === 0 && this.retired) this.host.drop(this.slot);
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
      const got = await this.childNow();
      const outcome = await new HostActionCall(got.child, ctx).runHttp(route, got.versionId, request);
      ended = outcome.ended;
      return outcome.response;
    } finally {
      void ended.then(() => {
        if (--this.inFlight === 0 && this.retired) this.host.drop(this.slot);
      });
    }
  }

  /** The child that runs this version's calls now (a new one if it died). */
  private async childNow() {
    try {
      return await this.host.get(this.slot);
    } catch (e) {
      throw e instanceof SandboxError ? new ExecutorFailure(e.message) : e;
    }
  }

  /** No more calls are expected: the child forgets this version once the last one ends (and stops, if it was its last). */
  retire() {
    if (this.retired) return;
    this.retired = true;
    collected.unregister(this);
    if (this.inFlight === 0) this.host.drop(this.slot);
  }

  get isRetired() {
    return this.retired;
  }
}

/** Drops a version from its child once the version is collected, if nothing retired it before. */
const collected = new FinalizationRegistry<{ host: ChildHost; slot: Slot }>(({ host, slot }) => host.drop(slot));

/**
 * Where a component instance's code runs (STUDY-168 PR 7): `shared`, in the child of the version it is loaded beside
 * (the app's), each instance its own version there (the default); `own`, in a child of its own (measured against it:
 * STUDY-171 §15).
 */
export type ComponentChildren = "shared" | "own";

export type ProcessExecutorOptions = SandboxProcessOptions & { components?: ComponentChildren };

export class ProcessExecutor implements Executor {
  readonly kind = "process" as const;
  private readonly versions = new Set<WeakRef<RemoteCodeVersion>>();
  private evaluator: Promise<SandboxProcess> | null = null;

  private readonly spawn: SandboxProcessOptions;
  private readonly components: ComponentChildren;
  /** The children that hold versions now. */
  private readonly hosts = new Set<ChildHost>();

  /** `options`: how its children start (tests only: a child that misbehaves), where components run (measurements). */
  constructor(options: ProcessExecutorOptions = {}) {
    const { components = "shared", ...spawn } = options;
    this.spawn = spawn;
    this.components = components;
  }

  /**
   * Loads `sources` in a child: a new one, or (`beside`, a component instance's code beside the app's version) the
   * child of that version, while it runs.
   */
  async load(sources: ModuleSource[], opts: LoadOptions, beside?: LoadedCode): Promise<RemoteCodeVersion> {
    let host: ChildHost | null = null;
    if (this.components === "shared" && beside instanceof RemoteCodeVersion && !beside.host.closed) host = beside.host;
    let placed: { slot: Slot; load: ChildLoad };
    if (host) placed = await host.add(sources, opts);
    else {
      const child = await SandboxProcess.start(this.spawn);
      host = new ChildHost(child, this.spawn, (h) => this.hosts.delete(h));
      this.hosts.add(host);
      try {
        placed = await host.add(sources, opts);
      } catch (e) {
        await host.close();
        throw e;
      }
    }
    const version = new RemoteCodeVersion(host, placed.slot, sources, placed.load, beside !== undefined);
    collected.register(version, { host, slot: placed.slot }, version);
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

  /**
   * The children that hold versions (tests, measurements): each one's pid, how many versions it runs, and how many it
   * said it held at its last load.
   */
  async children(): Promise<{ pid: number; versions: number; held: number }[]> {
    return Promise.all([...this.hosts].map(async (h) => ({ pid: await h.pid(), versions: h.size, held: h.held })));
  }

  release(version: LoadedCode) {
    if (version instanceof RemoteCodeVersion) version.retire();
  }

  /**
   * `version` serves now: every other app version this executor loaded is retired. A component instance's version
   * (loaded beside one) is the server's to release, when its instance gets another or goes.
   */
  installed(version: LoadedCode) {
    for (const ref of this.versions) {
      const v = ref.deref();
      if (!v || v.isRetired) this.versions.delete(ref);
      else if (v !== version && !v.beside) {
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
