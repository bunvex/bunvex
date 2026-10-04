import { SignInButton, UserButton } from "@clerk/clerk-react";
import { Authenticated, AuthLoading, Unauthenticated, useBunvexAuth, useMutation, useQuery } from "bunvex/react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../bunvex/_generated/api";
import type { Id } from "../bunvex/_generated/dataModel";

/** Store the signed-in user once the deployment has their token; the user's id, or null until then. */
function useStoreUser(): Id<"users"> | null {
  const { isAuthenticated } = useBunvexAuth();
  const store = useMutation(api.users.store);
  const [userId, setUserId] = useState<Id<"users"> | null>(null);
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    store().then((id) => {
      if (!cancelled) setUserId(id);
    });
    return () => {
      cancelled = true;
      setUserId(null);
    };
  }, [isAuthenticated, store]);
  return userId;
}

function Chat() {
  const userId = useStoreUser();
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await send({ body });
    setBody("");
  }

  return (
    <>
      <UserButton />
      <ul>
        {messages?.map((m) => (
          <li key={m._id}>
            <strong>{m.user === userId ? "You" : m.author}:</strong> {m.body}
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" />
        <button type="submit" disabled={!body || userId === null}>
          Send
        </button>
      </form>
    </>
  );
}

export function App() {
  return (
    <main>
      <h1>bunvex with Clerk</h1>
      <AuthLoading>Loading…</AuthLoading>
      <Unauthenticated>
        <SignInButton mode="modal" />
      </Unauthenticated>
      <Authenticated>
        <Chat />
      </Authenticated>
    </main>
  );
}
