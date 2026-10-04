import { bunvexQuery, useBunvexMutation } from "@bunvex/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  // TanStack's useQuery: no refetching needed, bunvex pushes every change into the cache.
  const { data: messages, isPending, error } = useQuery(bunvexQuery(api.messages.list, {}));
  const { mutate: send, isPending: sending } = useMutation({ mutationFn: useBunvexMutation(api.messages.send) });
  const [body, setBody] = useState("");

  if (error) return <p>Something went wrong: {error.message}</p>;
  return (
    <main>
      <h1>bunvex + TanStack Query</h1>
      {isPending ? (
        <p>Loading…</p>
      ) : (
        <ul>
          {messages.map((m) => (
            <li key={m._id}>
              <strong>{m.author}:</strong> {m.body}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send({ body, author: NAME }, { onSuccess: () => setBody("") });
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body || sending}>
          Send
        </button>
      </form>
    </main>
  );
}
