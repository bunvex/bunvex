import { useBunvex, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

function Chat() {
  // Prewarmed: when the button was hovered first, the result is already here on the first render.
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await send({ body, author: NAME });
    setBody("");
  }

  if (messages === undefined) return <p>Loading…</p>;
  return (
    <section>
      <ul>
        {messages.map((m) => (
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
    </section>
  );
}

export function App() {
  const client = useBunvex();
  const [open, setOpen] = useState(false);
  const [prewarmed, setPrewarmed] = useState(false);

  return (
    <main>
      <h1>Prewarming</h1>
      {open ? (
        <Chat />
      ) : (
        <button
          type="button"
          // Hovering is a strong hint of a click: subscribe now, so the chat renders with data.
          onMouseEnter={() => {
            client.prewarmQuery({ query: api.messages.list, args: {} });
            setPrewarmed(true);
          }}
          onClick={() => setOpen(true)}
        >
          Open the chat{prewarmed && " (prewarmed)"}
        </button>
      )}
    </main>
  );
}
