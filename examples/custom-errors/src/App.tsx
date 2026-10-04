import { useMutation, useQuery } from "bunvex/react";
import { BunvexError } from "bunvex/values";
import { Component, type FormEvent, type ReactNode, useState } from "react";
import { api } from "../bunvex/_generated/api";

const NAME = `User ${Math.floor(Math.random() * 10_000)}`;

/** The data a `BunvexError` carries, else a generic message (anything else is a bug, not the app's error). */
const describe = (error: unknown) =>
  error instanceof BunvexError
    ? typeof error.data === "string"
      ? error.data
      : `${error.data.message} (${error.data.count})`
    : "Unexpected error";

/** A query that throws throws in `useQuery`: an error boundary shows it, with a way out. */
class ErrorBoundary extends Component<{ children: ReactNode; fallback: (e: unknown) => ReactNode }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function Messages() {
  const messages = useQuery(api.messages.list);
  return (
    <ul>
      {messages?.map((m) => (
        <li key={m._id}>
          <strong>{m.author}:</strong> {m.body}
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const send = useMutation(api.messages.send);
  const clear = useMutation(api.messages.clear);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setBody("");
      await send({ body, author: NAME });
    } catch (err) {
      setError(describe(err));
      setBody(body);
    }
  }

  return (
    <main>
      <h1>Custom errors</h1>
      <ErrorBoundary
        key={attempt}
        fallback={(err) => (
          <p role="alert">
            {describe(err)}{" "}
            <button type="button" onClick={() => clear().then(() => setAttempt((n) => n + 1))}>
              Clear the messages
            </button>
          </p>
        )}
      >
        <Messages />
      </ErrorBoundary>
      <form onSubmit={onSubmit}>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="At most 50 characters" />
        <button type="submit" disabled={!body}>
          Send
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
