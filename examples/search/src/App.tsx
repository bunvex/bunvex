import { useMutation, useQuery } from "bunvex/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api";

export function App() {
  const [text, setText] = useState("");
  const [body, setBody] = useState("");
  // With no search text, every message; with some, the best matches. Both stay live.
  const all = useQuery(api.messages.list, text ? "skip" : {});
  const found = useQuery(api.messages.search, text ? { query: text } : "skip");
  const messages = text ? found : all;
  const send = useMutation(api.messages.send);

  return (
    <main>
      <h1>bunvex search</h1>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search messages…" />
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await send({ body, author: "me" });
          setBody("");
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
    </main>
  );
}
