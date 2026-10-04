import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";
import type { Id } from "../bunvex/_generated/dataModel";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

function Channel({ channel }: { channel: Id<"channels"> }) {
  const messages = useQuery(api.messages.list, { channel });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await send({ channel, body, author: NAME });
    setBody("");
  }

  return (
    <section>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <small>#{m.channelName}</small> <strong>{m.author}:</strong> {m.body}
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
  const channels = useQuery(api.channels.list);
  const addChannel = useMutation(api.channels.add);
  const [selected, setSelected] = useState<Id<"channels"> | null>(null);
  const [name, setName] = useState("");

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setSelected(await addChannel({ name }));
    setName("");
  }

  return (
    <main>
      <h1>Channels</h1>
      <nav>
        {channels?.map((c) => (
          <button key={c._id} type="button" aria-pressed={c._id === selected} onClick={() => setSelected(c._id)}>
            #{c.name}
          </button>
        ))}
      </nav>
      <form onSubmit={onAdd}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New channel" />
        <button type="submit" disabled={!name}>
          Add
        </button>
      </form>
      {selected && <Channel key={selected} channel={selected} />}
    </main>
  );
}
