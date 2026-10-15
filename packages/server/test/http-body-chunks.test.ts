// A streamed HTTP action body's chunks (STUDY-161 §15): Convex's `stream/extend` op takes an ArrayBuffer or a view of
// one, skips null and undefined, and refuses anything else with serde_v8's error, which names the value as v8's
// `Value::type_repr` does (each name checked on Convex's binary, differential/test/http-body-error.test.ts).
import { expect, test } from "bun:test";
import { meteredBody } from "../src/http-body.ts";

/** The body's error in the handler's turn when its start enqueues `value`, or null. */
async function early(value: unknown) {
  const body = meteredBody(
    new ReadableStream<unknown>({
      start(c) {
        c.enqueue(new Uint8Array(1));
        c.enqueue(value);
        c.close();
      },
    }) as ReadableStream<Uint8Array>,
  );
  const failed = await body.failedEarly();
  return failed && (failed.error as Error);
}

const got = (name: string) => `serde_v8 error: invalid type; expected: buffer, got: ${name}`;

test("a value that is not bytes fails the body in the handler's turn, named as v8 names it", async () => {
  const cases: [unknown, string][] = [
    ["a string", "string"],
    ["", "string"],
    [42, "Number"],
    [Number.NaN, "Number"],
    [true, "Boolean"],
    [1n, "bigint"],
    [Symbol("s"), "symbol"],
    [{ a: 1 }, "unknown"],
    [[104, 105], "array"],
    [new Blob(["x"]), "unknown"],
    [new String("s"), "unknown"],
    [new Error("e"), "unknown"],
    [new Map(), "Map"],
    [new Set(), "Set"],
    [new WeakMap(), "WeakMap"],
    [new WeakSet(), "WeakSet"],
    [new Map().keys(), "Map Iterator"],
    [new Set().values(), "Set Iterator"],
    [new Date(0), "Date"],
    [/x/, "RegExp"],
    [Promise.resolve(1), "Promise"],
    [() => 1, "function"],
    [async () => 1, "Async function"],
    [function* () {}, "Generator function"],
    [new Proxy([], {}), "Proxy"],
    [new SharedArrayBuffer(2), "SharedArrayBuffer"],
    [new Uint8Array(new SharedArrayBuffer(2)), "Uint8Array"],
    [new Float64Array(new SharedArrayBuffer(8)), "Float64Array"],
    [new DataView(new SharedArrayBuffer(2)), "DataView"],
  ];
  for (const [value, name] of cases) {
    const e = await early(value);
    expect([name, e?.message]).toEqual([name, got(name)]);
    // Raised by the runtime, not the app: no frames.
    expect(e!.stack).toBe(`Error: ${got(name)}`);
  }
});

test("a resizable ArrayBuffer, or a view of one, is refused as serde_v8 refuses it", async () => {
  for (const value of [
    new ArrayBuffer(2, { maxByteLength: 4 }),
    new Uint8Array(new ArrayBuffer(2, { maxByteLength: 4 })),
  ])
    expect((await early(value))?.message).toBe("serde_v8 error: can't create slice from resizable ArrayBuffer");
});

test("bytes of any kind, null and undefined pass; the body sends the bytes, in order", async () => {
  const values = [
    null,
    new Uint8Array([97]),
    undefined,
    new Uint8Array([98]).buffer,
    new DataView(new Uint8Array([99]).buffer),
    new Int8Array([100]),
  ];
  const body = meteredBody(
    new ReadableStream<unknown>({
      start(c) {
        for (const v of values) c.enqueue(v);
        c.close();
      },
    }) as ReadableStream<Uint8Array>,
  );
  expect(await body.failedEarly()).toBeNull();
  expect(await new Response(body.stream).text()).toBe("abcd");
  expect(await body.sent).toEqual({ bytes: 4, errors: [], tooLarge: false, disconnected: false });
});

test("a chunk that is not bytes after the handler's turn ends the body with what was sent, and its line", async () => {
  let n = 0;
  const body = meteredBody(
    new ReadableStream<unknown>({
      async pull(c) {
        await Bun.sleep(5);
        if (n++ === 0) c.enqueue(new Uint8Array([97]));
        else c.enqueue({ a: 1 });
      },
    }) as ReadableStream<Uint8Array>,
  );
  expect(await body.failedEarly()).toBeNull();
  expect(await new Response(body.stream).text()).toBe("a");
  expect(await body.sent).toEqual({
    bytes: 1,
    errors: [`Uncaught Error: ${got("unknown")}\n`],
    tooLarge: false,
    disconnected: false,
  });
});
