import { fetchMutation, fetchQuery } from "bunvex/nextjs";
import { revalidatePath } from "next/cache";
import { api } from "../../bunvex/_generated/api";

export const dynamic = "force-dynamic";

// A Server Action: runs on the server, called by the form below without client JavaScript.
async function increment() {
  "use server";
  await fetchMutation(api.counters.increment, { name: "server-only" });
  revalidatePath("/server-only");
}

export default async function ServerOnly() {
  const count = await fetchQuery(api.counters.get, { name: "server-only" });
  return (
    <main>
      <h1>Server Components only</h1>
      <p>Not live: the page shows the value it was rendered with, and re-renders after the action.</p>
      <form action={increment}>
        Clicked {count} times. <button type="submit">Click</button>
      </form>
    </main>
  );
}
