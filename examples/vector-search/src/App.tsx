import { useAction, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";
import type { Id } from "../bunvex/_generated/dataModel";

/** What to show for a failed call: a `BunvexError`'s message (its data), else the error's message. */
const errorText = (err: unknown) => {
  const data = (err as { data?: unknown }).data;
  return typeof data === "string" ? data : (err as Error).message;
};

type FoodResult = { _id: string; _score: number; description: string; cuisine: string };

function Foods() {
  const foods = useQuery(api.foods.list);
  const populate = useAction(api.foods.populate);
  const similar = useAction(api.foods.similar);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Actions call OpenAI: show their errors (a missing OPENAI_KEY says how to set it).
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    await f().catch((err) => setError(errorText(err)));
  };

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    await run(async () => setResults(await similar({ query })));
  }

  return (
    <section>
      <h2>Foods (the embedding in the row)</h2>
      <button type="button" onClick={() => run(() => populate())}>
        Add sample foods
      </button>
      <form onSubmit={onSearch}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Something spicy…" />
        <button type="submit" disabled={!query}>
          Search
        </button>
      </form>
      <ul>
        {(results ?? foods)?.map((f) => (
          <li key={f._id}>
            [{f.cuisine}] {f.description} {"_score" in f ? `(${f._score.toFixed(3)})` : null}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Movies() {
  const movies = useQuery(api.movies.list);
  const populate = useAction(api.movies.populate);
  const similar = useAction(api.movies.similar);
  const vote = useMutation(api.movies.vote);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ _id: Id<"movieEmbeddings">; _score: number }[] | null>(null);
  // The search's movies, live: a vote shows at once.
  const found = useQuery(api.movies.withScores, hits ? { results: hits } : "skip");
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    await f().catch((err) => setError(errorText(err)));
  };

  return (
    <section>
      <h2>Movies (the embedding in its own table)</h2>
      <button type="button" onClick={() => run(() => populate())}>
        Add sample movies
      </button>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run(async () => setHits(await similar({ query })));
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Dreams and heists…" />
        <button type="submit" disabled={!query}>
          Search
        </button>
      </form>
      <ul>
        {(found ?? movies)?.map((m) => (
          <li key={m._id}>
            {m.title} [{m.genre}] {m.votes} votes{" "}
            <button type="button" onClick={() => vote({ id: m._id, delta: 1 })}>
              +
            </button>
            <button type="button" onClick={() => vote({ id: m._id, delta: -1 })}>
              −
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function App() {
  return (
    <main>
      <h1>bunvex vector search</h1>
      <Foods />
      <Movies />
    </main>
  );
}
