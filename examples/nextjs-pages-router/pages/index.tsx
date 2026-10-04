import { useMutation, useQuery } from "bunvex/react";
import Head from "next/head";
import { api } from "../bunvex/_generated/api";

export default function Home() {
  // Live: a click in another tab shows up here.
  const clicks = useQuery(api.counter.get, { name: "clicks" });
  const increment = useMutation(api.counter.increment);
  return (
    <main>
      <Head>
        <title>bunvex with the Next.js Pages Router</title>
      </Head>
      <h1>A counter</h1>
      <p>Clicks: {clicks ?? "…"}</p>
      <button type="button" onClick={() => increment({ name: "clicks", by: 1 })}>
        Add one
      </button>
      <p>
        The same value from an API route, read on the server: <a href="/api/clicks">/api/clicks</a>
      </p>
    </main>
  );
}
