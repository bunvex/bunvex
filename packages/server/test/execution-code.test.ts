// Code versions across to an execution worker (STUDY-194 §4.8, 2b step iii): the registry a worker builds from the
// main thread's code messages resolves as the main thread's, for every example app and every load the server's
// pushed-code suites make (the sandbox's analysis corpus), and with components; each version is sent once per worker,
// and forgotten with the last epoch holding it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { LoadOptions, ModuleSource } from "../src/code-version.ts";
import { CodeShipper, newCodeHeld } from "../src/execution-code.ts";
import { loadCode } from "../src/function-executor.ts";
import { Functions, query } from "../src/functions.ts";

type Options = { seed: number[]; timestamp: number; env: Record<string, string>; importTimeoutMs?: number };
type Entry = { suite: string; kind: "load" | "evaluate"; sources: ModuleSource[]; options: Options };

const corpus = (
  JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(readFileSync(join(import.meta.dir, "../../sandbox/test/fixtures/parity-corpus.json.gz"))),
    ),
  ) as Entry[]
).filter((e) => e.kind === "load");

const loadOptions = (o: Options): LoadOptions => ({
  seed: Uint32Array.from(o.seed),
  timestamp: o.timestamp,
  env: o.env,
  ...(o.importTimeoutMs === undefined ? {} : { importTimeoutMs: o.importTimeoutMs }),
});

let worker: Worker;
let engine: Engine;
/** The worker's answers, in order: each request is answered before the next is read. */
let answers: ((text: string) => void)[] = [];
const ask = (text: string) =>
  new Promise<string>((resolve) => {
    answers.push(resolve);
    worker.postMessage(text);
  });

beforeAll(async () => {
  engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  worker = new Worker(new URL("./fixtures/execution-code-worker.ts", import.meta.url).href);
  worker.onmessage = (e: MessageEvent<string>) => answers.shift()!(e.data);
});
afterAll(() => {
  worker.terminate();
  answers = [];
});

/** The worker's description of `epoch`, after `messages`. */
async function inWorker(messages: string[], epoch: number) {
  for (const m of messages) worker.postMessage(m);
  const a = await ask(`?${epoch}`);
  if (a[0] === "!") throw new Error(a.slice(1));
  return JSON.parse(a);
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("a worker's registry resolves as the main thread's", () => {
  test("the corpus covers the example apps and the pushed-code suites", () => {
    expect(corpus.filter((e) => e.suite.startsWith("examples/")).length).toBeGreaterThan(20);
    expect(corpus.length).toBeGreaterThan(100);
  });

  test("every load of the corpus that loads", async () => {
    const shipper = new CodeShipper();
    const held = newCodeHeld();
    let compared = 0;
    for (const e of corpus) {
      let version: Awaited<ReturnType<typeof loadCode>>;
      try {
        version = await loadCode(e.sources, loadOptions(e.options));
      } catch {
        continue; // a failed load is never installed, so never sent
      }
      const fns = new Functions(engine);
      fns.installVersion(version);
      const messages = shipper.prepare(fns.codeEpoch, fns.codeSources(), held);
      expect(messages).not.toBeNull();
      // Each epoch number is a fresh registry's: forget it after, so the next entry's is sent.
      const there = await inWorker(messages!, fns.codeEpoch);
      expect(there, e.suite).toEqual(plain(fns.describeCode()));
      worker.postMessage(shipper.forget(fns.codeEpoch, held)!);
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
    expect(JSON.parse(await ask("#"))).toEqual({ versions: 0, epochs: 0 });
  }, 300_000);

  test("with components: the app's version and each instance's, with its runtime and routes", async () => {
    const examples = corpus.filter((e) => e.suite.startsWith("examples/"));
    const pick = (suite: string) => examples.find((e) => e.suite === suite)!;
    const app = await loadCode(pick("examples/http").sources, loadOptions(pick("examples/http").options));
    const a = await loadCode(pick("examples/rate-limiter").sources, loadOptions(pick("examples/rate-limiter").options));
    const b = await loadCode(pick("examples/workpool").sources, loadOptions(pick("examples/workpool").options));
    const fns = new Functions(engine);
    fns.swap(() => {
      fns.installVersion(app);
      fns.installComponentVersion(
        { id: "c1", path: "limiter", env: new Map([["K", { type: "value", value: "v" }]]), httpPrefix: "/lim/" },
        a,
      );
      fns.installComponentVersion({ id: "c2", path: "pool", env: new Map(), httpPrefix: null }, b);
    });
    const shipper = new CodeShipper();
    const held = newCodeHeld();
    const messages = shipper.prepare(fns.codeEpoch, fns.codeSources(), held)!;
    expect(messages.map((m) => m[0])).toEqual(["v", "v", "v", "k"]);
    const there = await inWorker(messages, fns.codeEpoch);
    expect(there).toEqual(plain(fns.describeCode()));
    expect((there as { componentFns: unknown[] }).componentFns.length).toBeGreaterThan(0);

    // The next epoch keeps two of the versions: only the new one is sent, and forgetting the first epoch drops the
    // version only it held.
    const first = fns.codeEpoch;
    fns.removeComponent("c2");
    const next = shipper.prepare(fns.codeEpoch, fns.codeSources(), held)!;
    expect(next.map((m) => m[0])).toEqual(["k"]);
    expect(await inWorker(next, fns.codeEpoch)).toEqual(plain(fns.describeCode()));
    worker.postMessage(shipper.forget(first, held)!);
    expect(JSON.parse(await ask("#"))).toEqual({ versions: 2, epochs: 1 });
    expect(held.versions.size).toBe(2);
    expect(await inWorker([], first).catch((e: Error) => e.message)).toBe(
      `code epoch ${first} was not sent, or was forgotten`,
    );
    worker.postMessage(shipper.forget(fns.codeEpoch, held)!);
    expect(JSON.parse(await ask("#"))).toEqual({ versions: 0, epochs: 0 });
  }, 60_000);
});

describe("what can be sent", () => {
  test("an epoch already held needs nothing", async () => {
    const e = corpus.find((x) => x.suite === "examples/tutorial")!;
    const fns = new Functions(engine);
    fns.installVersion(await loadCode(e.sources, loadOptions(e.options)));
    const shipper = new CodeShipper();
    const held = newCodeHeld();
    expect(shipper.prepare(fns.codeEpoch, fns.codeSources(), held)!.length).toBe(2);
    expect(shipper.prepare(fns.codeEpoch, fns.codeSources(), held)).toEqual([]);
  });

  test("functions given as maps have no sources: their calls stay in-thread", async () => {
    const fns = new Functions(engine);
    fns.register("m", { q: query({ args: {}, handler: () => 1 }) });
    expect(fns.codeSources()).toBeNull();
    expect(new CodeShipper().prepare(fns.codeEpoch, fns.codeSources(), newCodeHeld())).toBeNull();
    const e = corpus.find((x) => x.suite === "examples/tutorial")!;
    const version = await loadCode(e.sources, loadOptions(e.options));
    fns.install(version.functions, version.moduleHashes);
    expect(fns.codeSources()).toBeNull();
    fns.installVersion(version);
    expect(fns.codeSources()).toEqual({ app: version, components: [] });
  });
});
