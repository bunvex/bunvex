// Engine objects print as their name alone: `Tx {…}`, never their fields.
//
// Function code holds engine objects (`ctx.db`, a query, `ctx.db.system`), and `console.log` of one formats
// it with object-inspect (logs.ts in @bunvex/server), whose lines go back to the caller and to the log
// stream. Opened, a transaction prints the catalog, the store's state and other transactions' writes. Convex
// never has that problem: what its functions hold are thin JS shells over syscalls
// (npm-packages/convex/src/server/impl/database_impl.ts), and the engine lives in Rust, out of reach.
//
// So every engine class whose instances an app can reach — and, as a second line, the big ones behind
// them — answers the inspect hook that object-inspect, `util.inspect` and `Bun.inspect` all honour, with
// its name and nothing else: the same `Name {…}` an error message gives a non-plain object (DV-316).
// The name comes from the prototype, never from `this`, so a Proxy over the object (a query's reader view
// of its transaction) prints the same and runs no trap.

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

function opaque(this: unknown): string {
  let name = "Object";
  try {
    const proto = Object.getPrototypeOf(this);
    const ctor = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
    if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name) name = ctor.name;
  } catch {}
  return `${name} {…}`;
}

/** Make instances of each class (and of their subclasses) print as `Name {…}` when inspected. */
export function opaqueToInspect(...classes: { readonly prototype: object }[]): void {
  for (const c of classes)
    Object.defineProperty(c.prototype, INSPECT, {
      value: opaque,
      enumerable: false,
      configurable: true,
      writable: false,
    });
}
