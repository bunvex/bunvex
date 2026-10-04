import { useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../bunvex/_generated/api";

export function App() {
  const messages = useQuery(api.messages.list);
  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);
  const sendImage = useMutation(api.messages.sendImage);
  const sendMessage = useMutation(api.messages.sendMessage);
  const [body, setBody] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onSendImage(e: FormEvent) {
    e.preventDefault();
    if (!image) return;
    // 1. a URL to upload to, 2. the file's bytes POSTed there, 3. the returned id saved in a message.
    const uploadUrl = await generateUploadUrl();
    const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": image.type }, body: image });
    const { storageId } = await response.json();
    await sendImage({ storageId, author: "me" });
    setImage(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <main>
      <h1>bunvex file storage</h1>
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.author}:</strong>{" "}
            {"url" in m && m.url ? <img src={m.url} alt="" height={120} /> : <span>{m.body}</span>}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await sendMessage({ body, author: "me" });
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
