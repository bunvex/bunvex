import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  const messages = useQuery(api.messages.list);
  const count = useQuery(api.messages.count);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const list = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await send({ body, author: NAME, ...(list.length ? { tags: list } : {}) });
      setBody("");
      setTags("");
    } catch (err) {
      // A call the validators refuse never reaches the handler; the error says which field was wrong.
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Argument validation</h1>
      <p>{count ?? "…"} messages</p>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body} {m.tags.length > 0 && <em>#{m.tags.join(" #")}</em>}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" />
        <button type="submit">Send</button>
      </form>
      {error && <pre role="alert">{error}</pre>}
    </main>
  );
}
