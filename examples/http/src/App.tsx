import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

// A number per tab: the HTTP API finds a user's messages by it.
const NUMBER = Math.floor(Math.random() * 10_000);
const NAME = `User ${NUMBER}`;
const SITE = import.meta.env.VITE_BUNVEX_SITE_URL as string;

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await send({ body, author: NAME });
    setBody("");
  }

  return (
    <main>
      <h1>bunvex HTTP actions</h1>
      <p>
        You are <strong>{NAME}</strong>. Messages posted over HTTP show up here too:
      </p>
      <pre>
        {`curl -X POST ${SITE}/postMessage -H 'Content-Type: application/json' -d '{"author":"${NAME}","body":"hi"}'\n`}
        {`curl ${SITE}/getAuthorMessages/${NUMBER}`}
      </pre>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
    </main>
  );
}
