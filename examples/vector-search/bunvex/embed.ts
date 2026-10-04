// A text's embedding, from OpenAI's embeddings API (an action's `fetch`). OPENAI_BASE_URL points elsewhere
// (the end-to-end test's stand-in).
import { BunvexError } from "bunvex/values";

/** A deployment variable the example needs: missing, a message saying how to set it (shown in the page). */
function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new BunvexError(
      `${name} is not set: run \`bunx bunvex env set ${name} <value>\` in this example's directory.`,
    );
  return value;
}

export async function embed(text: string): Promise<number[]> {
  const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com"}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${required("OPENAI_KEY")}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!response.ok) throw new Error(`OpenAI failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as { data: { embedding: number[] }[] };
  return json.data[0]!.embedding;
}
