# Generated images in file storage

A chat where `/image <prompt>` posts a generated image. The action `images:send` (`bunvex/images.ts`) checks
the prompt with OpenAI's moderation, asks OpenAI for an image, downloads it, and keeps it with
`ctx.storage.store` — the generated URL expires, the stored file does not — then posts the message through an
internal mutation. The list query gives each image the URL its stored file is served at (`ctx.storage.getUrl`).

It needs an OpenAI API key, in the deployment's `OPENAI_API_KEY` variable:

```sh
bun install
bunx bunvex env set OPENAI_API_KEY <your key>
bun run dev
```

The functions read it as `process.env.OPENAI_API_KEY`; typed declarations of a deployment's variables come with
`defineApp`. The action calls OpenAI's HTTP API with `fetch` (no SDK). `OPENAI_BASE_URL` (default
`https://api.openai.com`) points it elsewhere: its end-to-end test (`test/e2e.test.ts`) runs a local stand-in
for OpenAI, so it needs no network and no key.
