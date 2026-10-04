import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

/** Ways to break the arguments on purpose: each is refused by `send`'s validators, which say why. */
const MISTAKES = {
  none: (args: Record<string, unknown>) => args,
  "no body": ({ body: _, ...rest }: Record<string, unknown>) => rest,
  "a number as the body": (args: Record<string, unknown>) => ({ ...args, body: 42 }),
  "tags as a string": (args: Record<string, unknown>) => ({ ...args, tags: "not-a-list" }),
  "an extra field": (args: Record<string, unknown>) => ({ ...args, extra: true }),
};

export function App() {
  const messages = useQuery(api.messages.list);
  const count = useQuery(api.messages.count);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mistake, setMistake] = useState<keyof typeof MISTAKES>("none");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const list = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      setBody("");
      setTags("");
      const args = { body, author: NAME, ...(list.length ? { tags: list } : {}) };
      // The client does not check arguments: the server's validators do, before the handler runs.
      await send(MISTAKES[mistake](args) as typeof args);
    } catch (err) {
      // A call the validators refuse never reaches the handler; the error says which field was wrong.
      setError((err as Error).message);
      setBody(body);
      setTags(tags);
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
        <select value={mistake} onChange={(e) => setMistake(e.target.value as keyof typeof MISTAKES)}>
          {Object.keys(MISTAKES).map((k) => (
            <option key={k} value={k}>
              {k === "none" ? "valid arguments" : `with a mistake: ${k}`}
            </option>
          ))}
        </select>
        <button type="submit">Send</button>
      </form>
      {error && <pre role="alert">{error}</pre>}
    </main>
  );
}
