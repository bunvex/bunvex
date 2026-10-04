import { useMutation, usePaginatedQuery } from "bunvex/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api";

export function App() {
  // The first 5 messages, newest first; `loadMore` asks for older ones. New messages appear at the top live.
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 5 });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  return (
    <main>
      <h1>bunvex pagination</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await send({ body, author: "me" });
          setBody("");
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body}>
          Send
        </button>
        <button
          type="button"
          onClick={async () => {
            for (let i = 1; i <= 20; i++) await send({ body: `Message ${i}`, author: "bot" });
          }}
        >
          Add 20 messages
        </button>
      </form>
      <ul>
        {results.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => loadMore(5)} disabled={status !== "CanLoadMore"}>
        {status === "Exhausted" ? "No more messages" : "Load more"}
      </button>
    </main>
  );
}
