import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { nextUp, outsideExecution, seededRandom, wallClock } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}
// A slow engine-side step (like a persistence round trip), which runs outside the execution.
const tick = () => outsideExecution(() => new Promise((r) => setTimeout(r, 5)));

describe("deterministic execution", () => {
  test("time is frozen for the whole execution, in every form", async () => {
    const e = await engine();
    const before = wallClock();
    const seen = await e.query(async () => {
      const a = Date.now();
      await tick();
      // biome-ignore lint/complexity/useDateNow: `new Date()` is one of the forms under test
      return { a, b: Date.now(), date: new Date().getTime(), str: Date(), perf: new Date(0).getTime() };
    });
    expect(seen.a).toBe(seen.b);
    expect(seen.date).toBe(seen.a);
    expect(seen.str).toBe(new Date(seen.a).toString());
    expect(seen.perf).toBe(0); // an explicit argument is untouched
    expect(seen.a).toBeGreaterThanOrEqual(Math.floor(before));
    await tick();
    expect(Date.now()).toBeGreaterThan(seen.a); // outside an execution the clock runs
  });

  test("concurrent executions each keep their own frozen time", async () => {
    const e = await engine();
    const slow = e.query(async () => {
      const t = Date.now();
      await tick();
      await tick();
      return [t, Date.now()];
    });
    await tick();
    const fast = e.query(() => Date.now());
    const [[t0, t1], t2] = await Promise.all([slow, fast]);
    expect(t1).toBe(t0);
    expect(t2).toBeGreaterThan(t0);
  });

  test("Math.random is seeded per execution; a seed replays its sequence", async () => {
    const e = await engine();
    const run = () => e.query(() => [Math.random(), Math.random(), Math.random()]);
    const [x, y] = [await run(), await run()];
    expect(x).not.toEqual(y);
    for (const v of x) expect(v >= 0 && v < 1).toBe(true);
    const seed = new Uint32Array([1, 2, 3, 4]);
    const [r1, r2] = [seededRandom(seed), seededRandom(seed)];
    for (let i = 0; i < 100; i++) expect(r1()).toBe(r2());
  });

  // STUDY-66 §4: Convex's not_allowed_in_udf, its timers, its seeded crypto, its crypto_rng.
  const NO = (what: string) => `Can't use ${what} in queries and mutations. Please consider using an action.`;

  test("fetch is refused with Convex's message, a rejection the function can catch", async () => {
    const e = await engine();
    await expect(e.query(() => fetch("http://127.0.0.1:1/"))).rejects.toThrow(NO("fetch()"));
    const caught = await e.mutation(async () => {
      try {
        await fetch("http://127.0.0.1:1/");
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(caught).toBe(NO("fetch()"));
  });

  test("setTimeout / setInterval return, then fail the function: a try around them does not help", async () => {
    const e = await engine();
    let ran = false;
    await expect(
      e.query(() => {
        try {
          setTimeout(() => {
            ran = true;
          }, 0);
        } catch {}
        return "done";
      }),
    ).rejects.toThrow(NO("setTimeout"));
    await expect(
      e.mutation(async () => {
        const id = setInterval(() => {}, 1);
        await tick();
        return typeof id;
      }),
    ).rejects.toThrow(NO("setInterval"));
    await tick();
    expect(ran).toBe(false);
    // Outside an execution, the real timers.
    await new Promise((r) => setTimeout(r, 1));
  });

  test("crypto.getRandomValues and randomUUID are allowed, from a stream fixed per execution", async () => {
    const e = await engine();
    const draw = () =>
      e.query(() => {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const words = crypto.getRandomValues(new Uint32Array(3));
        return { bytes: [...bytes], words: [...words], uuid: crypto.randomUUID() };
      });
    const [a, b] = [await draw(), await draw()];
    // A fresh seed per execution: two runs differ (as two Math.random sequences do).
    expect(a.bytes).not.toEqual(b.bytes);
    expect(a.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(a.bytes).size).toBeGreaterThan(8);
    // One stream per execution: successive draws differ.
    const twice = await e.query(() => [
      [...crypto.getRandomValues(new Uint8Array(8))],
      [...crypto.getRandomValues(new Uint8Array(8))],
    ]);
    expect(twice[0]).not.toEqual(twice[1]);
    await expect(e.query(() => crypto.getRandomValues(new Float32Array(4) as never))).rejects.toThrow(
      "The provided ArrayBufferView is not an integer array type",
    );
    await expect(e.query(() => crypto.getRandomValues(new Uint8Array(65537)))).rejects.toThrow(
      "Byte length (65537) exceeds the number of bytes of entropy available via this API (65536)",
    );
    expect(await e.query(() => crypto.getRandomValues(new Uint8Array(65536)).length)).toBe(65536);
    expect(crypto.getRandomValues(new Uint8Array(4)).length).toBe(4);
  });

  test("crypto.subtle: cryptographic randomness is refused, the rest works", async () => {
    const e = await engine();
    const RNG = NO("cryptographic randomness");
    await expect(
      e.query(() => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"])),
    ).rejects.toThrow(RNG);
    const rsa = (await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    await expect(
      e.mutation(() => crypto.subtle.encrypt({ name: "rsa-oaep" }, rsa.publicKey, new Uint8Array(4))),
    ).rejects.toThrow(RNG);
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await expect(
      e.query(() => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new Uint8Array(4))),
    ).rejects.toThrow(RNG);
    // Deterministic operations work: digest, HMAC, AES-GCM with the app's IV.
    const hmac = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const aes = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);
    const ok = await e.query(async () => {
      const d = await crypto.subtle.digest("SHA-256", new Uint8Array(4));
      const s = await crypto.subtle.sign("HMAC", hmac, new Uint8Array(4));
      const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, aes, new Uint8Array(4));
      return [d.byteLength, s.byteLength, c.byteLength];
    });
    expect(ok).toEqual([32, 32, 20]);
  });

  test("engine work inside an execution (persistence calls) sees the real globals", async () => {
    const e = await engine();
    const seen = await e.mutation(async () => {
      const frozen = Date.now();
      await tick();
      return outsideExecution(async () => {
        crypto.getRandomValues(new Uint8Array(4)); // what the MongoDB driver does for its sessions
        await new Promise((r) => setTimeout(r, 5));
        return { frozen, real: Date.now() };
      });
    });
    expect(seen.real).toBeGreaterThan(seen.frozen);
  });

  test("Date keeps working as a class", async () => {
    const e = await engine();
    const seen = await e.query(() => ({
      inst: new Date() instanceof Date,
      utc: Date.UTC(2020, 0, 1),
      parse: Date.parse("2020-01-01T00:00:00Z"),
    }));
    expect(seen).toEqual({ inst: true, utc: 1577836800000, parse: 1577836800000 });
  });

  test("inserts get strictly increasing creation times, not before Date.now(), in insert order", async () => {
    const e = await engine();
    const now = await e.mutation(async (db) => {
      for (let i = 0; i < 50; i++) await db.insert("items", { i });
      return Date.now();
    });
    const docs = await e.query((db) => db.query("items").collect());
    expect(docs.map((d: Doc) => d.i)).toEqual([...Array(50).keys()]);
    for (let i = 1; i < docs.length; i++) expect(docs[i]._creationTime).toBeGreaterThan(docs[i - 1]._creationTime);
    expect(docs[0]._creationTime).toBeGreaterThanOrEqual(now);
  });

  test("nextUp returns the next double", () => {
    expect(nextUp(1)).toBe(1 + Number.EPSILON);
    const x = 1_790_000_000_000.5;
    expect(nextUp(x)).toBeGreaterThan(x);
    expect((x + nextUp(x)) / 2 === x || (x + nextUp(x)) / 2 === nextUp(x)).toBe(true);
  });
  test("performance.now() is fixed in a query, at the execution's start (0.1 ms steps)", async () => {
    const e = await engine();
    const seen = await e.query(async () => {
      const a = performance.now();
      await tick();
      await tick();
      return { a, b: performance.now(), date: Date.now() };
    });
    expect(seen.b).toBe(seen.a);
    expect(Math.abs(seen.a * 10 - Math.round(seen.a * 10))).toBeLessThan(1e-6); // a multiple of 0.1 ms
    // the same instant as the frozen Date.now(), on performance's own origin
    expect(Math.abs(performance.timeOrigin + seen.a - seen.date)).toBeLessThan(1.1);
    expect(performance.now()).toBeGreaterThan(seen.a); // outside an execution the clock runs
  });

  test("performance.now() counts up in a mutation, from its start", async () => {
    const e = await engine();
    const outsideBefore = performance.now();
    const seen = await e.mutation(async () => {
      const a = performance.now();
      await tick();
      await tick();
      return { a, b: performance.now(), date: Date.now() };
    });
    const outsideAfter = performance.now();
    expect(seen.b - seen.a).toBeGreaterThanOrEqual(9); // two 5 ms ticks elapsed
    expect(seen.a).toBeGreaterThanOrEqual(Math.floor(outsideBefore * 10) / 10);
    // On performance's own origin, `a` is the frozen Date.now() (its floor, to 0.1 ms) plus the time from the
    // execution's start to the body's first read, which a slow run (coverage) stretches past a millisecond:
    // bounded by the time the whole call took, not by a fixed 1.1 ms.
    const offset = performance.timeOrigin + seen.a - seen.date;
    expect(offset).toBeGreaterThanOrEqual(-0.1);
    expect(offset).toBeLessThan(1.1 + (outsideAfter - outsideBefore));
    expect(Math.abs(seen.b * 10 - Math.round(seen.b * 10))).toBeLessThan(1e-6);
  });
});
