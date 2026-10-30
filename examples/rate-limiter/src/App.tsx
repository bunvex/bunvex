// Two panels: a playground whose controls are the limit's config, with a live timeline of its tokens, and
// `useRateLimit` on a fixed limit, saying when the next call fits.

import type { RateLimitConfig } from "@bunvex/rate-limiter";
import { type GetRateLimitValueQuery, type UseRateLimitOptions, useRateLimit } from "@bunvex/rate-limiter/react";
import { useMutation } from "@bunvex/react";
import { useEffect, useState } from "react";
import { api } from "../bunvex/_generated/api.js";

export function App() {
  return (
    <main>
      <h1>@bunvex/rate-limiter</h1>
      <p>
        Limits are kept in the component's tables, so every call is checked in the same transaction as the work it
        guards. The browser computes a limit's tokens from one live query, with no polling.
      </p>
      <Playground />
      <HookDemo />
    </main>
  );
}

type Kind = RateLimitConfig["kind"];

function Playground() {
  const consume = useMutation(api.playground.consumeRateLimit);
  const reset = useMutation(api.playground.resetRateLimit);
  const [kind, setKind] = useState<Kind>("token bucket");
  const [rate, setRate] = useState(1);
  const [period, setPeriod] = useState(2);
  const [capacity, setCapacity] = useState(3);
  const [shards, setShards] = useState(1);
  const [count, setCount] = useState(1);
  const [reserve, setReserve] = useState(false);
  const [last, setLast] = useState<string>();
  const config = { kind, rate, period: period * 1000, capacity, shards } as RateLimitConfig;

  const spend = async () => {
    const r = await consume({ config, count, reserve });
    setLast(
      r.ok
        ? r.retryAfter
          ? `reserved: runs in ${seconds(r.retryAfter)}`
          : "passed"
        : `refused: retry in ${seconds(r.retryAfter)}`,
    );
  };
  const number = (label: string, value: number, set: (n: number) => void, min = 1) => (
    <label>
      {label}{" "}
      <input type="number" min={min} value={value} onChange={(e) => set(Math.max(min, Number(e.target.value)))} />
    </label>
  );
  return (
    <section>
      <h2>Playground</h2>
      <div className="controls">
        <label>
          kind{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option>token bucket</option>
            <option>fixed window</option>
          </select>
        </label>
        {number("rate", rate, setRate)}
        {number("period (s)", period, setPeriod)}
        {number("capacity", capacity, setCapacity)}
        {number("shards", shards, setShards)}
      </div>
      <Timeline
        query={api.playground.getRateLimit}
        opts={{ config, getServerTimeMutation: api.playground.getServerTime }}
      />
      <div className="controls">
        {number("count", count, setCount)}
        <label>
          <input type="checkbox" checked={reserve} onChange={(e) => setReserve(e.target.checked)} /> reserve
        </label>
        <button type="button" onClick={spend}>
          Spend {count}
        </button>
        <button type="button" onClick={() => reset({}).then(() => setLast("reset"))}>
          Reset
        </button>
        {last && <span className="last">{last}</span>}
      </div>
    </section>
  );
}

const WINDOW_MS = 10_000;

/** The limit's tokens over the last 10 s, sampled every 100 ms from `useRateLimit`'s `check`. */
function Timeline({ query, opts }: { query: GetRateLimitValueQuery; opts: UseRateLimitOptions }) {
  const { check } = useRateLimit(query, opts);
  const [points, setPoints] = useState<{ t: number; value: number }[]>([]);
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const value = check(now, 0)?.value;
      if (value === undefined) return;
      setPoints((ps) => [...ps.filter((p) => now - p.t < WINDOW_MS), { t: now, value }]);
    }, 100);
    return () => clearInterval(timer);
  }, [check]);
  const now = Date.now();
  const capacity = Math.max(1, opts.config?.capacity ?? opts.config?.rate ?? 1);
  const low = Math.min(0, ...points.map((p) => p.value));
  const y = (value: number) => 100 - ((value - low) / (capacity - low)) * 100;
  const path = points.map((p, i) => `${i ? "L" : "M"}${(1 - (now - p.t) / WINDOW_MS) * 300},${y(p.value)}`).join("");
  const current = points.at(-1)?.value;
  return (
    <figure className="timeline">
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Tokens over the last 10 seconds">
        <line x1="0" x2="300" y1={y(0)} y2={y(0)} className="zero" />
        <path d={path} />
      </svg>
      <figcaption>{current === undefined ? "…" : `${current.toFixed(2)} of ${capacity} tokens`}</figcaption>
    </figure>
  );
}

function HookDemo() {
  const consume = useMutation(api.example.consumeTokens);
  const [count, setCount] = useState(4);
  const [error, setError] = useState<string>();
  const { status, check } = useRateLimit(api.example.getRateLimit, {
    getServerTimeMutation: api.example.getServerTime,
    count,
  });
  const [value, setValue] = useState<number>();
  useEffect(() => {
    const timer = setInterval(() => setValue(check(Date.now(), 0)?.value), 100);
    return () => clearInterval(timer);
  }, [check]);
  return (
    <section>
      <h2>useRateLimit</h2>
      <pre>{`const { status, check } = useRateLimit(api.example.getRateLimit, {
  getServerTimeMutation: api.example.getServerTime,
  count: ${count},
});`}</pre>
      <p>
        The limit: 10 tokens a minute, 10 at most. You have <strong>{value?.toFixed(2) ?? "…"}</strong>.
      </p>
      <p className={`verdict ${status?.ok === false ? "no" : "yes"}`}>
        {status === undefined
          ? "…"
          : status.ok
            ? `${count} fit now`
            : `${count} fit at ${new Date(status.retryAt).toLocaleTimeString()} (in ${seconds(status.retryAt - Date.now())})`}
      </p>
      <label>
        count{" "}
        <input type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} />
      </label>
      <button
        type="button"
        disabled={status?.ok === false}
        onClick={() => {
          setError(undefined);
          consume({ count }).catch((e: Error) => setError(e.message));
        }}
      >
        Spend {count}
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const seconds = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)} s`;
