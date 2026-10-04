# GIFs from an action

A chat where `/giphy <words>` posts a GIF. Queries and mutations cannot call other services, so `sendGif` is an
action (`bunvex/messages.ts`): it asks Giphy's translate API for a GIF, then posts it with an internal mutation
(`sendGifMessage`), which clients cannot call directly.

It needs a Giphy API key, in the deployment's `GIPHY_KEY` variable:

```sh
bun install
bunx bunvex env set GIPHY_KEY <your key>
bun run dev
```

The functions read it as `process.env.GIPHY_KEY`; typed declarations of a deployment's variables come with
`defineApp`. `GIPHY_BASE_URL` (default `https://api.giphy.com`) points the action elsewhere: its end-to-end
test (`test/e2e.test.ts`) runs a local stand-in for Giphy, so it needs no network and no key.
