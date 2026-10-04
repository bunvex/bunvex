import { useAction, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

/** What to show for a failed call: a `BunvexError`'s message (its data), else the error's message. */
const errorText = (err: unknown) => {
  const data = (err as { data?: unknown }).data;
  return typeof data === "string" ? data : (err as Error).message;
};

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const sendGif = useAction(api.messages.sendGif);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // "/giphy <words>" posts a GIF, through the action; anything else is a text message.
    setError(null);
    setBody("");
    try {
      if (body.startsWith("/giphy ")) await sendGif({ queryString: body.slice(7), author: NAME });
      else await send({ body, author: NAME });
    } catch (err) {
      setError(errorText(err));
      setBody(body);
    }
  }

  return (
    <main>
      <h1>bunvex GIF chat</h1>
      <p>
        Type <code>/giphy cats</code> to post a GIF.
      </p>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong>{" "}
            {m.format === "giphy" ? (
              <iframe src={m.body} title="GIF" width={240} height={180} />
            ) : (
              <span>{m.body}</span>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message, or /giphy …" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
