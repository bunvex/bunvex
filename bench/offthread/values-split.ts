// STUDY-190 §4.3, candidate (c): is it worth moving a query result's value work to a thread? For one uncached
// bench query's result (20 documents of `items`), the main thread's cost of
//   - "decode": what the read does per document (JSON.parse of the stored text, fromJsonValue);
//   - "result": what the server does with the result (the lone-surrogate walk and the size of checkReturns, the
//     egress size, toJsonValue and JSON.stringify);
// against the cost of handing the same data to a Worker and getting the answer back:
//   - the 20 values as objects (structured clone both ways);
//   - the stored JSON texts (strings) in, the result text out: what a thread that does the whole query (reads
//     included) would exchange with the main thread.
//   bun bench/offthread/values-split.ts
import {
  fromJsonValue,
  measureRawValue,
  rawValueSize,
  toJsonValue,
  type Value,
  valueHasLoneSurrogate,
} from "@bunvex/values";

const N = Number(process.env.N ?? 20_000);
const stored = Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({
    _id: `k57${String(i).padStart(29, "0")}`,
    _creationTime: 1761488000000.5 + i,
    tenantId: "t42",
    title: `item ${i} of tenant 42`,
    status: i % 3 ? "open" : "done",
    amount: 1234 + i,
    createdAt: 1761488000000 - i * 1000,
  }),
);

const decode = () => stored.map((t) => fromJsonValue(JSON.parse(t)));
const result = (docs: Value[]) => {
  if (valueHasLoneSurrogate(docs)) throw new Error("surrogate");
  measureRawValue(docs as Value);
  rawValueSize(docs as Value);
  return JSON.stringify(toJsonValue(docs as Value));
};

function time(name: string, f: () => unknown) {
  for (let i = 0; i < 2000; i++) f();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) f();
  const us = ((performance.now() - t0) * 1000) / N;
  console.log(`| ${name} | ${us.toFixed(1)} |`);
  return us;
}

const workerSrc = `
self.onmessage = (e) => postMessage(typeof e.data === "string" ? e.data : e.data);
`;
const url = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));

/** Main-thread time per message pair with WINDOW in flight (the worker only echoes). */
async function exchange(name: string, make: () => unknown) {
  const w = new Worker(url);
  const run = (n: number) =>
    new Promise<void>((resolve) => {
      let sent = 0;
      let got = 0;
      w.onmessage = () => {
        if (++got === n) return resolve();
        if (sent < n) {
          sent++;
          w.postMessage(make());
        }
      };
      for (; sent < Math.min(64, n); sent++) w.postMessage(make());
    });
  await run(2000);
  const t0 = performance.now();
  await run(N);
  const us = ((performance.now() - t0) * 1000) / N;
  w.terminate();
  console.log(`| ${name} | ${us.toFixed(1)} |`);
  return us;
}

console.log(`Bun ${Bun.version}, ${process.platform}/${process.arch}, N=${N}\n`);
console.log("| main-thread work per query (20 documents) | µs |");
console.log("|---|---:|");
const docs = decode();
time("decode: JSON.parse + fromJsonValue of 20 stored documents", decode);
time("result: surrogate walk, two sizes, toJsonValue, JSON.stringify", () => result(docs));
const resultText = result(docs);
await exchange("hand-off: the 20 values as objects, both ways (structured clone)", () => docs);
await exchange("hand-off: 20 stored JSON texts in, one result text out (strings)", () => stored);
await exchange("hand-off: one result text each way (strings)", () => resultText);
process.exit(0);
