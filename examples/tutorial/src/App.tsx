import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

// A name per tab, so two tabs make a conversation.
const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  // Live: every message anyone sends shows up here, with no refresh.
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBody("");
    await send({ body, author: NAME });
  }

  return (
    <main>
      <h1>bunvex chat</h1>
      <p>
        You are <strong>{NAME}</strong>. Open this page in another tab to chat with yourself.
      </p>
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
