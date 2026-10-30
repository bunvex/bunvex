// Three panels, one per named worker: a work queue that sums events, a scoreboard whose totals one loop keeps, and
// LLM requests sent in batches as a token budget allows. Each shows its worker's status, live.
import { useMutation, useQuery } from "@bunvex/react";
import { type ReactNode, useState } from "react";
import { api } from "../bunvex/_generated/api.js";

type WorkerStatus = { kind: "idle" | "running" | "stopped" } | null | undefined;

export function App() {
  return (
    <main>
      <h1>@bunvex/batch-worker</h1>
      <p>
        Insert rows cheaply, <code>ping</code> the worker, and one loop drains the queue in batches: it restarts if it
        dies and goes idle when there is nothing to do.
      </p>
      <EventsPanel />
      <ScoresPanel />
      <LlmPanel />
    </main>
  );
}

function Status({ status }: { status: WorkerStatus }) {
  return <span className={`status ${status?.kind ?? "never"}`}>{status?.kind ?? "never run"}</span>;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <strong>{value}</strong> {label}
    </div>
  );
}

function EventsPanel() {
  const totals = useQuery(api.example.getTotals, {});
  const status = useQuery(api.example.workerStatus, {}) as WorkerStatus;
  const addEvent = useMutation(api.example.addEvent);
  const [value, setValue] = useState("1");
  return (
    <section>
      <h2>
        Work queue <Status status={status} />
      </h2>
      <input type="number" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Event value" />
      <button type="button" onClick={() => addEvent({ value: Number(value) || 0 })}>
        Add event
      </button>
      <button type="button" onClick={() => Array.from({ length: 25 }, (_, i) => addEvent({ value: i + 1 }))}>
        +25
      </button>
      <Metric label="queued" value={totals?.pending ?? 0} />
      <Metric label="processed" value={totals?.count ?? 0} />
      <Metric label="running total" value={totals?.total ?? 0} />
    </section>
  );
}

const TEAMS = ["Red", "Blue", "Green"] as const;

function ScoresPanel() {
  const data = useQuery(api.aggregates.getTotals, {});
  const status = useQuery(api.aggregates.workerStatus, {}) as WorkerStatus;
  const recordScore = useMutation(api.aggregates.recordScore);
  const totals: Record<string, number> = data?.totals ?? {};
  const max = Math.max(1, ...Object.values(totals));
  const rain = () =>
    Array.from({ length: 50 }, () =>
      recordScore({
        team: TEAMS[Math.floor(Math.random() * TEAMS.length)]!,
        points: 1 + Math.floor(Math.random() * 5),
      }),
    );
  return (
    <section>
      <h2>
        Live scoreboard <Status status={status} />
      </h2>
      {TEAMS.map((team) => (
        <button type="button" key={team} onClick={() => recordScore({ team, points: 3 })}>
          {team} +3
        </button>
      ))}
      <button type="button" onClick={rain}>
        Score rain ×50
      </button>
      {TEAMS.map((team) => (
        <div key={team} className="bar">
          <span>{team}</span>
          <div className={`fill ${team.toLowerCase()}`} style={{ width: `${((totals[team] ?? 0) / max) * 100}%` }} />
          <span>{totals[team] ?? 0}</span>
        </div>
      ))}
      <p>{data?.pending ?? 0} scores waiting in the queue</p>
    </section>
  );
}

const PROMPTS = [
  "What does a batch worker do?",
  "Why does one writer avoid conflicts?",
  "How does a token bucket refill?",
  "What is a debounce?",
  "When does a loop go idle?",
];

function LlmPanel() {
  const requests = useQuery(api.rateLimited.listRequests, {});
  const stats = useQuery(api.rateLimited.stats, {});
  const status = useQuery(api.rateLimited.workerStatus, {}) as WorkerStatus;
  const submitRequest = useMutation(api.rateLimited.submitRequest);
  const [prompt, setPrompt] = useState("");
  // About 150 tokens each, against a budget of 300 per 5 s: two requests already fill it.
  const submit = (text: string) => {
    if (text.trim()) void submitRequest({ prompt: text.trim(), inputTokens: 120 + text.trim().length });
  };
  return (
    <section>
      <h2>
        Rate-limited LLM batches <Status status={status} />
      </h2>
      <p>Requests go out five at a time, each batch when the token budget (300 per 5 s) allows it.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(prompt);
          setPrompt("");
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask something"
          aria-label="Prompt"
        />
        <button type="submit">Submit</button>
        <button type="button" onClick={() => PROMPTS.concat(PROMPTS, PROMPTS).forEach(submit)}>
          +15
        </button>
      </form>
      <Metric label="queued" value={stats?.pending ?? 0} />
      <Metric label="in flight" value={stats?.started ?? 0} />
      <Metric label="done" value={stats?.finished ?? 0} />
      <ul className="requests">
        {(requests ?? []).map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is display only, newest first
          <li key={i}>
            <span className={`state ${r.state}`}>{r.state}</span> {r.prompt}
            {r.response && <em> {r.response}</em>}
          </li>
        ))}
      </ul>
    </section>
  );
}
