import { v } from "bunvex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";

// OpenAI's API; OPENAI_BASE_URL points elsewhere (the end-to-end test's stand-in).
const openai = async (path: string, body: unknown) => {
  const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com"}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenAI failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
};

/**
 * Generate an image for `prompt` and post it: check the prompt with OpenAI's moderation, ask for an image,
 * download it, and keep it in file storage — the image's URL from OpenAI expires, the stored file does not.
 */
export const send = action({
  args: { prompt: v.string(), author: v.string() },
  handler: async (ctx, { prompt, author }) => {
    const moderation = (await openai("/v1/moderations", { input: prompt })) as {
      results: { flagged: boolean; categories: Record<string, boolean> }[];
    };
    const verdict = moderation.results[0];
    if (verdict?.flagged) throw new Error(`Your prompt was flagged: ${JSON.stringify(verdict.categories)}`);

    const generated = (await openai("/v1/images/generations", { prompt, size: "256x256" })) as {
      data: { url: string }[];
    };
    const image = await fetch(generated.data[0]!.url);
    if (!image.ok) throw new Error(`Downloading the image failed: ${image.status}`);

    const storageId = await ctx.storage.store(await image.blob());
    await ctx.runMutation(internal.messages.sendDallEMessage, { storageId, author, prompt });
  },
});
