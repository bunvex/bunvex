// A call's error across the call boundary (STUDY-194 §10.2, 2b commit 0b): made again as the same class, with its
// fields, whichever side it was made on.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import vm from "node:vm";
import { OutOfRetentionError } from "@bunvex/core";
import { BunvexError } from "@bunvex/values";
import { decodeCallError, encodeCallError, knownCallError, markedTransient } from "../src/call-errors.ts";
import { AuditLogLimitError } from "../src/log.ts";

const across = (e: unknown, isTransient?: (e: unknown) => boolean) =>
  decodeCallError(encodeCallError(e, isTransient)) as Record<string, unknown> & Error;

test("every error class the server's modules export is made again as itself", async () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const missing: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts")) continue;
    for (const [name, v] of Object.entries(await import(`${dir}${f}`)))
      if (typeof v === "function" && v.prototype instanceof Error && !knownCallError(v as never))
        missing.push(`${f}: ${name}`);
  }
  expect(missing).toEqual([]);
});

test("a server error keeps its class and its fields, bigints included", () => {
  const e = across(new OutOfRetentionError(5n, 9n));
  expect(e).toBeInstanceOf(OutOfRetentionError);
  expect(e.ts).toBe(5n);
  expect(e.minTs).toBe(9n);
  expect(e.message).toBe("Timestamp 5 is outside of write log retention window (minimum timestamp 9)");
  expect(e.name).toBe("OutOfRetentionError");
  expect(across(new AuditLogLimitError("TooManyAuditLogLines", "over"))).toBeInstanceOf(AuditLogLimitError);
});

test("a BunvexError keeps its data, bytes and bigints included; the stack and cause cross too", () => {
  const data = { n: 1n, b: new Uint8Array([1, 2]).buffer, l: [null, "x", -0, Number.NaN], o: { k: true } };
  const original = new BunvexError(data as never);
  const e = across(original) as unknown as BunvexError<never>;
  expect(e).toBeInstanceOf(BunvexError);
  expect(e.data).toEqual(data as never);
  expect(Object.is((e.data as { l: unknown[] }).l[2], -0)).toBe(true);
  expect(e.stack).toBe(original.stack);
  const caused = across(new Error("outer", { cause: new RangeError("inner") }));
  expect(caused.cause).toBeInstanceOf(RangeError);
  expect((caused.cause as Error).message).toBe("inner");
});

test("an app's error is made again in a realm of its own, with its name; a thrown value as itself", () => {
  const appError = vm.runInContext(
    `class Nope extends TypeError { constructor() { super("no"); this.name = "Nope"; this.code = 7; } }; new Nope()`,
    vm.createContext({}),
  );
  const e = across(appError);
  expect(e).not.toBeInstanceOf(Error);
  expect(Object.prototype.toString.call(e)).toBe("[object Error]");
  expect(e.name).toBe("Nope");
  expect(e.message).toBe("no");
  expect(e.code).toBe(7);
  expect(decodeCallError(encodeCallError("plain"))).toBe("plain");
  expect(decodeCallError(encodeCallError(undefined))).toBeUndefined();
  // The server's own `Error`, a store's, stays one of this realm.
  expect(across(new Error("disk"))).toBeInstanceOf(Error);
});

test("the store's answer that an error is transient crosses with it, down its causes", () => {
  class Flaky extends Error {}
  const e = across(new Error("read", { cause: new Flaky("x") }), (x) => x instanceof Flaky);
  expect(markedTransient(e)).toBe(false);
  expect(markedTransient(e.cause)).toBe(true);
});

test("an error whose fields do not cross is a system error naming it", () => {
  const e = across(Object.assign(new Error("f"), { fn: () => 1 }));
  expect(e.name).toBe("ExecutorFailure");
  expect(e.message).toContain("an error that does not cross the call boundary: Error");
});
