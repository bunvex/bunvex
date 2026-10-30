// The chat. Its loader starts the query, so the server renders the page with the messages and a client-side
// navigation finds them in the cache; `useSuspenseQuery` reads them, and keeps them live in the browser.
import { useMutation } from "@bunvex/react";
import { bunvexQuery } from "@bunvex/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../../bunvex/_generated/api";

const messages = bunvexQuery(api.messages.list, {});

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(messages),
  component: Chat,
});

function Chat() {
  const { data } = useSuspenseQuery(messages);
  const send = useMutation(api.messages.send);
  // A random name, picked in the browser: the server's render and the browser's first one must match (hydration).
  const [author, setAuthor] = useState<string | null>(null);
  useEffect(() => setAuthor(`User ${Math.floor(Math.random() * 10000)}`), []);
  const [body, setBody] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || !author) return;
    setBody("");
    await send({ body: text, author });
  };

  return (
    <main>
      <h1>Chat</h1>
      <p>
        You are <strong>{author ?? "…"}</strong>
      </p>
      <ul>
        {data.map((m) => (
          <li key={m._id}>
            {m.author}: {m.body}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body.trim() || !author}>
          Send
        </button>
      </form>
    </main>
  );
}
