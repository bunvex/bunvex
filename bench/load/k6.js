// HTTP load for the benchmark server (bench/server.ts). One scenario per process, chosen by SCENARIO.
// The old k6 script is gone, so the calls are rebuilt from bench/functions.ts and the published tables:
// a cached read repeats one argument list; an uncached read changes it every time, which is what made that
// row follow storage latency instead of clustering with the cached row.
//   k6 run -e SCENARIO=cached -e VUS=8 -e DURATION=10s -e BENCH_URL=http://127.0.0.1:3210 bench/load/k6.js
import http from "k6/http";
import { Rate } from "k6/metrics";

const errors = new Rate("bench_errors");
const vus = Number(__ENV.VUS || 8);
const duration = __ENV.DURATION || "10s";

export const options = {
  scenarios: {
    bench: {
      executor: "constant-vus",
      vus,
      duration,
      // Stop waiting for the last iterations quickly, so the measured window stays the duration.
      gracefulStop: "1s",
    },
  },
};

const base = __ENV.BENCH_URL || "http://127.0.0.1:3210";
// A 503 (retries spent on one hot key) is a result of the scenario, not a transport failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 599 }));

function call(kind, path, args) {
  const res = http.post(`${base}/api/${kind}`, JSON.stringify({ path, args }), {
    headers: { "Content-Type": "application/json" },
    tags: { name: path },
  });
  const body = typeof res.body === "string" ? res.body : "";
  errors.add(!body.startsWith('{"status":"success"'));
}

export function handleSummary(data) {
  const body = JSON.stringify(data);
  // stdout replaces k6's own summary. The file path has to be relative to the working directory:
  // an absolute path is ignored.
  const out = { stdout: `${body}\n` };
  if (__ENV.SUMMARY) out[__ENV.SUMMARY] = body;
  return out;
}

export default function () {
  // Unique across VUs, and inside the float range, so two calls never share a cache key by accident.
  const n = __VU * 1000000000 + __ITER;
  const tenantId = `t${n % 1000}`;
  switch (__ENV.SCENARIO) {
    case "cached":
      call("query", "bench:listCached", {});
      break;
    case "uncached":
      // `n` is not read by the handler (the function declares no args validator). It is part of the request,
      // so the cache key changes every call and the read goes to storage for the whole run. `tenantId` is one
      // of the 1000 seeded tenants, so the page is 20 documents.
      call("query", "bench:listByTenant", { tenantId, n });
      break;
    case "insert":
      call("mutation", "bench:insertItem", { tenantId });
      break;
    case "increment1000":
      call("mutation", "bench:increment", { key: `k${n % 1000}` });
      break;
    case "increment1":
      call("mutation", "bench:increment", { key: "k0" });
      break;
    case "action":
      call("action", "bench:readThenWrite", { tenantId });
      break;
    case "mix":
      // 9 of every 10 iterations are reads, per VU. The reads miss the cache the same way the uncached row does.
      if (__ITER % 10 === 0) call("mutation", "bench:insertItem", { tenantId });
      else call("query", "bench:listByTenant", { tenantId, n });
      break;
    default:
      throw new Error(`unknown SCENARIO=${__ENV.SCENARIO}`);
  }
}
