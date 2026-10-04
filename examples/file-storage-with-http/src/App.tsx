import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../bunvex/_generated/api";

// The HTTP actions' origin (`bunvex dev` writes it to .env.local).
const SITE = import.meta.env.VITE_BUNVEX_SITE_URL as string;
const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

export function App() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onSendImage(e: FormEvent) {
    e.preventDefault();
    if (!image) return;
    // One request: the HTTP action stores the file and posts the message.
    await fetch(`${SITE}/sendImage?author=${encodeURIComponent(NAME)}`, {
      method: "POST",
      headers: { "Content-Type": image.type },
      body: image,
    });
    setImage(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <main>
      <h1>bunvex file storage over HTTP</h1>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong>{" "}
            {m.format === "image" ? (
              <img src={`${SITE}/getImage?storageId=${m.body}`} alt="" height={120} />
            ) : (
              <span>{m.body}</span>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await send({ body, author: NAME });
          setBody("");
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
      <form onSubmit={onSendImage}>
        <input type="file" accept="image/*" ref={fileInput} onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
        <button type="submit" disabled={!image}>
          Send image
        </button>
      </form>
    </main>
  );
}
