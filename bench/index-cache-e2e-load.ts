// One load process of bench/index-cache-e2e.ts: CONC concurrent HTTP clients against URL for SECS, each call a
// `chat:send` mutation (WRITE_PCT %) or a `chat:list` query, the user and channel drawn with a Zipf-like skew.
// Prints one JSON line: the latencies (ms) of the queries and of the mutations, and the errors.
//   bun bench/index-cache-e2e-load.ts <url> <ids.json>     Env: CONC, SECS, WRITE_PCT, SKEW
import { readFileSync } from "node:fs";
import { BunvexHttpClient } from "bunvex/browser";

const [url, idsFile] = process.argv.slice(2) as [string, string];
const { channels, users } = JSON.parse(readFileSync(idsFile, "utf8")) as { channels: string[]; users: string[] };
const CONC = Number(process.env.CONC ?? 16);
const SECS = Number(process.env.SECS ?? 20);
const WRITE_PCT = Number(process.env.WRITE_PCT ?? 10);
const SKEW = Number(process.env.SKEW ?? 1);

function zipf(n: number, s: number): () => number {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) cdf[i] = sum += 1 / (i + 1) ** s;
  return () => {
    const x = Math.random() * sum;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
const pickChannel = zipf(channels.length, SKEW);
const pickUser = zipf(users.length, SKEW);

const client = new BunvexHttpClient(url, { logger: false });
const queries: number[] = [];
const mutations: number[] = [];
let errors = 0;
let firstError: string | undefined;
const end = performance.now() + SECS * 1000;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (performance.now() < end) {
      const args = { user: users[pickUser()]!, channel: channels[pickChannel()]! };
      const write = Math.random() * 100 < WRITE_PCT;
      const s = performance.now();
      try {
        if (write) await client.mutation("chat:send" as never, args as never);
        else await client.query("chat:list" as never, args as never);
        (write ? mutations : queries).push(performance.now() - s);
      } catch (e) {
        errors++;
        firstError ??= String(e);
      }
    }
  }),
);
console.log(JSON.stringify({ queries, mutations, errors, firstError }));
