// What pushed code sees of an error's stack (STUDY-150), as Convex's runtime shows it:
//
//   udf-runtime/src/errors.ts `setupSourceMapping`   a V8 function's `error.stack`: the source-mapped frames alone,
//                                                     its runtime's own trimmed (`JsError::from_frames`), no header
//   node-executor/src/errors.ts                       a Node action's: `Error: <message>`, then the frames, Node's
//                                                     own (`node:https`) among them, which agent-base reads
//   convex/src/server/impl/syscall.ts                 a syscall's failure made again in the app's code
//     `performAsyncSyscall`                           (`new Error(e.message)`), so its frames are where the app
//                                                     awaited it (`at async …`)
//
// bunvex's engine runs in the server's realm, not in the app's: an error it throws (`db.patch`, the scheduler, a
// nested call) carries the server's frames and paths, which the app could read (`e.stack`) and return or log. Each
// pushed context therefore formats its own errors' stacks (`Error.prepareStackTrace`, called by Bun on the first
// read), and the context a function gets is a view whose every call gives the server's error the frames of the
// app's call instead, made in the app's realm where the call was awaited (or made, when it threw at once).
//
// A nested call's error (`ctx.runQuery`, `runMutation`, `runAction`) is, in Convex, made again in the caller's code
// (`performAsyncSyscall`: `new Error(e.message)`, or `ConvexError` with its data): an error of the caller's realm,
// `instanceof Error` there. The server makes it (`toCallerError`, functions.ts) and marks it (`asCallerError`); the
// view gives it the caller's realm, its `Error` or its `BunvexError` (STUDY-171 §15, Q-PR7-2).
import vm from "node:vm";
import { BunvexError, isBunvexError, stringifyValueForError } from "@bunvex/values";
import { isSystemError, stackAfterMessage } from "./errors.ts";
import { log } from "./log.ts";
import { mapStack } from "./stack-map.ts";

/** Where a context keeps its call wrapper: on its `Function.prototype`, so each pushed handler reaches it. */
const APP_ERRORS = Symbol("bunvex.appErrors");

type CallSite = { isAsync?: () => boolean; toString(): string };
type Call = (fn: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) => unknown;

/**
 * The errors the server made for a nested call's caller: the view moves each into the caller's realm. Under `process`
 * the mark crosses the wire (`caller` on a thrown error), and the child marks the error it makes again.
 */
const callerErrors = new WeakSet<object>();

/** `e`, marked as a nested call's error for its caller (`installAppErrors` gives it the caller's realm). */
export function asCallerError<E>(e: E): E {
  if (e !== null && typeof e === "object") callerErrors.add(e);
  return e;
}

/** Whether `e` is a nested call's error for its caller (`asCallerError`). */
export const isCallerError = (e: unknown): boolean => e !== null && typeof e === "object" && callerErrors.has(e);

/** A pushed module's frame (`stack-map.ts` `moduleUrl`), named or not. */
const APP_FRAME = /^\s+at (?:.* \()?bunvex:\//m;

/** The frame lines of a mapped stack. */
const framesOf = (stack: string) =>
  stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .join("\n");

/** The app's frames of `callsites`, mapped to its sources, one `    at …` line each. */
function appFrames(callsites: CallSite[], node: boolean): string {
  let raw = "";
  for (const c of callsites) raw += `    at ${c.isAsync?.() ? "async " : ""}${String(c)}\n`;
  return framesOf(mapStack(raw, node));
}

/** Convex's Node executor header: `Error`, then the message when there is one, whatever the error's class. */
function nodeHeader(e: unknown): string {
  let message = "";
  try {
    const m = (e as { message?: unknown } | null)?.message;
    message = m === undefined || m === null ? "" : String(m);
  } catch {}
  return message ? `Error: ${message}` : "Error";
}

const withHeader = (node: boolean, e: unknown, frames: string) =>
  node ? (frames ? `${nodeHeader(e)}\n${frames}` : nodeHeader(e)) : frames;

/**
 * Install a pushed context's error stacks: its `Error.prepareStackTrace` (the app's own errors), and the wrapper
 * `appContext` gives the engine's errors through. `node`: a `"use node"` context, with Node's header, and Node's own
 * frames kept among the app's (`mapStack`'s `nodeFrames`: DV-482 as amended, STUDY-188 Q2), as libraries read them.
 */
export function installAppErrors(context: vm.Context, node: boolean): void {
  const format = (e: unknown, callsites: CallSite[]) => withHeader(node, e, appFrames(callsites, node));
  // The app's own `BunvexError`, a class of its realm (an `Error` there, its stack formatted as the app's other
  // errors), still a `BunvexError` to the server (`isBunvexError`: the registered symbol is every realm's); and to the
  // app, any `BunvexError` is one, the engine's included.
  const AppBunvexError = vm.runInContext(
    `(isBunvexError, stringify) => {
  const ordinary = Function.prototype[Symbol.hasInstance];
  return class BunvexError extends Error {
    name = "BunvexError";
    data;
    [Symbol.for("BunvexError")] = true;
    constructor(data) {
      super(typeof data === "string" ? data : stringify(data));
      this.data = data;
    }
    static [Symbol.hasInstance](v) {
      return this === BunvexError ? isBunvexError(v) : ordinary.call(this, v);
    }
  };
}`,
    context,
    { filename: "bunvex-runtime:app-errors.js" },
  )(isBunvexError, stringifyValueForError) as { prototype: object };
  appBunvexErrors.set(context, AppBunvexError);
  const appError = vm.runInContext("Error.prototype", context) as object;
  // A server error the app's call threw, given the app's frames; `site` is an error made in the app's realm at the
  // call (after its `await`, for a promise that rejected). The error itself is kept: its class, data and codes; a
  // nested call's (`asCallerError`) takes the app's realm, as Convex's caller makes it again: the app's `Error`, or
  // with data the app's `BunvexError`. The object stays the server's, so what the server knows of it holds (the
  // operation it came from under `process`, a timeout's identity).
  const fix = (e: unknown, site: Error) => {
    if (!(e instanceof Error) || isSystemError(e)) return e;
    if (callerErrors.has(e)) Object.setPrototypeOf(e, isBunvexError(e) ? AppBunvexError.prototype : appError);
    // Thrown before the call returned, the error already holds the app's frames (Convex's synchronous checks, in
    // its library, show those); otherwise the frames of the app's `await`.
    const own = stackAfterMessage(e);
    let frames: string;
    if (APP_FRAME.test(own)) frames = framesOf(mapStack(own, node));
    else {
      const stack = String(site.stack ?? "");
      frames = node ? stack.slice(stack.indexOf("\n") + 1 || stack.length) : stack;
    }
    try {
      Object.defineProperty(e, "stack", { value: withHeader(node, e, frames), writable: true, configurable: true });
    } catch {}
    return e;
  };
  const call = vm.runInContext(
    `(format, fix, ServerPromise) => {
  Error.prepareStackTrace = (e, callsites) => format(e, callsites);
  const site = () => new Error();
  const then = Promise.prototype.then;
  const settle = async (p) => {
    try {
      // A server promise awaited as one of this realm's (\`then\` of this realm): no thenable job between.
      return await (p instanceof ServerPromise ? then.call(p) : p);
    } catch (e) {
      throw fix(e, site());
    }
  };
  return (fn, self, args) => {
    let r;
    try {
      r = Reflect.apply(fn, self, args);
    } catch (e) {
      throw fix(e, site());
    }
    return r !== null && typeof r === "object" && typeof r.then === "function" ? settle(r) : r;
  };
}`,
    context,
    { filename: "bunvex-runtime:app-errors.js" },
  )(format, fix, Promise) as Call;
  const fnProto = vm.runInContext("Function.prototype", context) as object;
  const viewOf = views(call);
  Object.defineProperty(fnProto, APP_ERRORS, { value: viewOf });
  appViews.set(context, viewOf);
}

const appBunvexErrors = new WeakMap<vm.Context, unknown>();
const appViews = new WeakMap<vm.Context, <T extends object>(v: T) => T>();

/**
 * A server module's namespace as a pushed context imports it: `@bunvex/values` with the context's `BunvexError`;
 * `@bunvex/server` with `log` seen through the context's wrapper, so an error `log.audit` throws (a key starting with
 * "$", the lines past their limit) has the app's frames, not the server's (Convex makes it in the app's bundle,
 * `audit_logging.ts`).
 */
export function appNamespace(context: vm.Context, ns: Record<string, unknown>): Record<string, unknown> {
  let out = ns;
  const own = appBunvexErrors.get(context);
  if (own !== undefined && ns.BunvexError === BunvexError) out = { ...out, BunvexError: own };
  const view = appViews.get(context);
  if (view !== undefined && ns.log === log) out = { ...out, log: view(log) };
  return out;
}

/**
 * A server object a call returned that the app goes on calling (a query builder, an iterator): not a value, nor a
 * promise (the wrapper's own, already the app's).
 */
const isServerObject = (v: object) => {
  if (typeof (v as { then?: unknown }).then === "function") return false;
  const proto = Object.getPrototypeOf(v);
  return proto !== Object.prototype && proto !== Array.prototype && proto !== null;
};

/** The views of one context: each server object seen through `call`, made once. */
function views(call: Call) {
  const proxies = new WeakMap<object, object>();
  const view = <T extends object>(target: T): T => {
    let p = proxies.get(target);
    if (!p) {
      p = new Proxy(target, handlerOf(target));
      proxies.set(target, p);
    }
    return p as T;
  };
  /** `fn` called on `self` through `call`; a server object it returns seen through a view too. */
  const method =
    (fn: (...a: unknown[]) => unknown, self: object) =>
    (...args: unknown[]) => {
      const r = call(fn, self, args);
      return r !== null && typeof r === "object" && isServerObject(r) ? view(r) : r;
    };
  /** What a property reads as: a method bound to its object, an object seen through a view. */
  const seen = (target: object, v: unknown) =>
    typeof v === "function" ? method(v as (...a: unknown[]) => unknown, target) : view(v as object);
  // One handler per object: its properties' wrappers, kept while the property holds the same value.
  const handlerOf = (target: object): ProxyHandler<object> => {
    const wrapped = new Map<PropertyKey, { v: unknown; w: unknown }>();
    // A frozen object's constant properties must read as themselves (a proxy's invariant).
    const frozen = Object.isFrozen(target);
    return {
      get(_, key) {
        const v = Reflect.get(target, key, target);
        if (v === null || (typeof v !== "object" && typeof v !== "function") || frozen) return v;
        const c = wrapped.get(key);
        if (c !== undefined && c.v === v) return c.w;
        const w = seen(target, v);
        wrapped.set(key, { v, w });
        return w;
      },
    };
  };
  /** A function's context: a plain object (as the server's), its members seen through views. */
  return <T extends object>(ctx: T): T => {
    const out: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(ctx)) {
      const get = Object.getOwnPropertyDescriptor(ctx, key)?.get;
      if (get) {
        // A lazy member (ctx.rooms) stays lazy: seen through a view on first read.
        let w: unknown;
        let made = false;
        Object.defineProperty(out, key, {
          enumerable: true,
          configurable: true,
          get() {
            if (!made) {
              const v = get.call(ctx);
              w = v !== null && (typeof v === "object" || typeof v === "function") ? seen(ctx, v) : v;
              made = true;
            }
            return w;
          },
        });
        continue;
      }
      const v = (ctx as Record<PropertyKey, unknown>)[key];
      out[key] = v !== null && (typeof v === "object" || typeof v === "function") ? seen(ctx, v) : v;
    }
    return out as T;
  };
}

/**
 * The context a pushed function's handler gets: `ctx` seen through its realm's wrapper (`installAppErrors`), or
 * `ctx` itself for a function registered in-process (its frames are the developer's own).
 */
export function appContext<T extends object>(handler: unknown, ctx: T): T {
  const viewOf = (handler as { [APP_ERRORS]?: <V extends object>(v: V) => V } | null | undefined)?.[APP_ERRORS];
  return viewOf ? viewOf(ctx) : ctx;
}
