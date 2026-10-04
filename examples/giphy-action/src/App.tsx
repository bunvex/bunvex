import { useAction, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const sendGif = useAction(api.messages.sendGif);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // "/giphy <words>" posts a GIF, through the action; anything else is a text message.
    if (body.startsWith("/giphy ")) await sendGif({ queryString: body.slice(7), author: NAME });
    else await send({ body, author: NAME });
    setBody("");
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
    </main>
  );
}
