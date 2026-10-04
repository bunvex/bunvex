import { useAction, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const generate = useAction(api.images.send);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // "/image <prompt>" generates and posts an image; anything else is a text message.
      if (body.startsWith("/image ")) await generate({ prompt: body.slice(7), author: NAME });
      else await send({ body, author: NAME });
      setBody("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>bunvex generated images</h1>
      <p>
        Type <code>/image a cat in a hat</code> to post a generated image.
      </p>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong>{" "}
            {m.url ? <img src={m.url} alt={m.prompt} height={160} /> : <span>{m.body}</span>}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message, or /image …" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
