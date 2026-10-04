import { useMutation, useQuery } from "bunvex/react";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

function Chat() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const sendLater = useMutation(api.messages.sendLater);
  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);
  const sendImage = useMutation(api.messages.sendImage);
  const [body, setBody] = useState("");
  const [delay, setDelay] = useState(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBody("");
    if (delay > 0) await sendLater({ delaySeconds: delay, body, author: NAME });
    else await send({ body, author: NAME });
  }

  async function onImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const response = await fetch(await generateUploadUrl(), {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    const { storageId } = await response.json();
    await sendImage({ file: storageId, author: NAME });
    e.target.value = "";
  }

  return (
    <section>
      <h2>Chat</h2>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong> {"url" in m && m.url ? <img src={m.url} alt="" height={120} /> : m.body}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <label>
          in <input type="number" min={0} value={delay} onChange={(e) => setDelay(Number(e.target.value))} /> s
        </label>
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
      <input type="file" accept="image/*" onChange={onImage} />
    </section>
  );
}

function Admin() {
  const jobs = useQuery(api.admin.scheduledSends);
  const files = useQuery(api.admin.files);
  const cancel = useMutation(api.admin.cancelSend);
  return (
    <section>
      <h2>Scheduled sends (`_scheduled_functions`)</h2>
      <ul>
        {jobs?.map((j) => (
          <li key={j._id}>
            {new Date(j.scheduledTime).toLocaleTimeString()}: {j.state.kind}
            {j.state.kind === "pending" && (
              <button type="button" onClick={() => cancel({ job: j._id })}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
      <h2>Files (`_storage`)</h2>
      <ul>
        {files?.map((f) => (
          <li key={f._id}>
            {f.author}: {f.contentType ?? "unknown type"}, {f.size} bytes
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App() {
  return (
    <main>
      <h1>System tables</h1>
      <Chat />
      <Admin />
    </main>
  );
}
