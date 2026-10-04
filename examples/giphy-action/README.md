# GIFs from an action

A chat where `/giphy <words>` posts a GIF. Queries and mutations cannot call other services, so `sendGif` is an
action (`bunvex/messages.ts`): it asks Giphy's translate API for a GIF, then posts it with an internal mutation
(`sendGifMessage`), which clients cannot call directly.

It needs a Giphy API key, in the deployment's `GIPHY_KEY` variable:

```sh
bun install
bun run dev                                  # starts the local deployment, pushes the functions, opens the page
```

Then, in another terminal in this directory (the deployment exists once `bun run dev` has started it):

```sh
bunx bunvex env set GIPHY_KEY <your key>
```

The variable takes effect at the next call, with no restart. Until it is set, the page shows "GIPHY_KEY is not
set" with this command.

The functions read it as `process.env.GIPHY_KEY`; typed declarations of a deployment's variables come with
`defineApp`. `GIPHY_BASE_URL` (default `https://api.giphy.com`) points the action elsewhere: its end-to-end
test (`test/e2e.test.ts`) runs a local stand-in for Giphy, so it needs no network and no key.
