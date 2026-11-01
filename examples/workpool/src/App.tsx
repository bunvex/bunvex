// Three pools side by side: start jobs on one, watch how many run at once against its limit, how retries show up,
// and how each job ends; cancel what has not started.
import { useMutation, useQuery } from "@bunvex/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api.js";

type Pool = "big" | "small" | "serial";
const ABOUT: Record<Pool, string> = {
  big: "20 at once; a failed job is retried up to 3 times, with a growing wait.",
  small: "3 at once; a failed job is not retried.",
  serial: "One at a time, in order.",
};

export function App() {
  const pools = useQuery(api.tasks.list, {});
  const [failRate, setFailRate] = useState(0.3);
  return (
    <main>
      <h1>@bunvex/workpool</h1>
      <p>
        Enqueue as much work as you like: each pool runs at most its limit at once, retries what fails if told to, and
        calls back when each job ends.
      </p>
      <label>
        failure rate{" "}
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={failRate}
          onChange={(e) => setFailRate(Number(e.target.value))}
        />{" "}
        {Math.round(failRate * 100)}%
      </label>
      <div className="pools">
        {(pools ?? []).map((p) => (
          <PoolPanel key={p.pool} {...p} failRate={failRate} />
        ))}
      </div>
    </main>
  );
}

type Task = { id: string; label: string; state: string; attempts: number; error: string | null };

function PoolPanel({
  pool,
  limit,
  running,
  tasks,
  failRate,
}: {
  pool: Pool;
  limit: number;
  running: number;
  tasks: Task[];
  failRate: number;
}) {
  const start = useMutation(api.tasks.start);
  const cancelAll = useMutation(api.tasks.cancelAll);
  return (
    <section>
      <h2>{pool}</h2>
      <p className="about">{ABOUT[pool]}</p>
      <div className="meter" title={`${running} of ${limit} running`}>
        <div style={{ width: `${(running / limit) * 100}%` }} />
      </div>
      <p>
        {running} / {limit} running
      </p>
      <button type="button" onClick={() => start({ pool, count: 1, failRate })}>
        +1
      </button>
      <button type="button" onClick={() => start({ pool, count: 10, failRate })}>
        +10
      </button>
      <button type="button" onClick={() => cancelAll({ pool })}>
        Cancel the rest
      </button>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <span className={`state ${t.state}`}>{t.state}</span> {t.label}
            {t.attempts > 1 && <span className="attempts"> ×{t.attempts}</span>}
            {t.error && <em> {t.error}</em>}
          </li>
        ))}
      </ul>
    </section>
  );
}
