import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const sendExpiring = useMutation(api.messages.sendExpiring);
  const [body, setBody] = useState("");

  async function post(e: FormEvent, expiring: boolean) {
    e.preventDefault();
    await (expiring ? sendExpiring({ body, author: NAME }) : send({ body, author: NAME }));
    setBody("");
  }

  return (
    <main>
      <h1>Self-destructing messages</h1>
      <p>A message sent with "Send, then disappear" counts down and deletes itself: the server schedules it.</p>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => post(e, false)}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body}>
          Send
        </button>
        <button type="button" disabled={!body} onClick={(e) => post(e, true)}>
          Send, then disappear
        </button>
      </form>
    </main>
  );
}
