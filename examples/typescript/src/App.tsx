import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";
import type { Doc } from "../bunvex/_generated/dataModel";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

/** One message: its type is the schema's document, `_id` and `_creationTime` included. */
function Message({ message }: { message: Doc<"messages"> }) {
  return (
    <li>
      <strong>{message.author}:</strong> {message.body}{" "}
      <small>{new Date(message._creationTime).toLocaleTimeString()}</small>
    </li>
  );
}

export function App() {
  // `useQuery`'s result is typed from the query's return type: `Doc<"messages">[] | undefined`.
  const messages = useQuery(api.messages.list);
  // The mutation takes exactly `send`'s arguments, and resolves to its `Id<"messages">`.
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBody("");
    await send({ body, author: NAME });
  }

  return (
    <main>
      <h1>bunvex with TypeScript</h1>
      <ul>
        {messages?.map((m) => (
          <Message key={m._id} message={m} />
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
