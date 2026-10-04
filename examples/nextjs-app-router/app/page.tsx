import { preloadQuery } from "bunvex/nextjs";
import Link from "next/link";
import { api } from "../bunvex/_generated/api";
import { Counter } from "./Counter";

// Rendered for each request: the counter's value is read when the page is asked for, not at build time.
export const dynamic = "force-dynamic";

export default async function Home() {
  // On the server: the value at render time, in the HTML from the first byte.
  const preloaded = await preloadQuery(api.counters.get, { name: "clicks" });
  return (
    <main>
      <h1>bunvex + Next.js</h1>
      <p>The count below was read by a Server Component, then the Client Component keeps it live.</p>
      <Counter preloaded={preloaded} />
      <p>
        Without client JavaScript: <Link href="/server-only">a Server Component and a Server Action</Link>.
      </p>
    </main>
  );
}
