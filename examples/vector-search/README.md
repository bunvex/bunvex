# Vector search

Search by meaning, two ways (`bunvex/schema.ts`):

- **Foods** keep their embedding in the row, in a `vectorIndex` with `cuisine` as a filter field. Adding a food is
  an action (`foods:insert`): it asks OpenAI for the embedding, then inserts the row through an internal mutation.
  `foods:similar` embeds the search text, runs `ctx.vectorSearch` (optionally filtered by cuisines), and reads the
  documents through a query.
- **Movies** are saved at once by a mutation (`movies:insert`), which schedules an action to compute the
  embedding and keep it in a table of its own (`movieEmbeddings`, filtered by genre). `movies:similar` returns ids
  and scores; `movies:withScores` turns them into movies, live, so votes show at once.

It needs an OpenAI API key, in the deployment's `OPENAI_KEY` variable:

```sh
bun install
bun run dev                                  # starts the local deployment, pushes the functions, opens the page
```

Then, in another terminal in this directory (the deployment exists once `bun run dev` has started it):

```sh
bunx bunvex env set OPENAI_KEY <your key>
```

The variable takes effect at the next call, with no restart. Until it is set, the page shows "OPENAI_KEY is not
set" with this command.

The functions read it as `process.env.OPENAI_KEY`; typed declarations of a deployment's variables come with
`defineApp`. `OPENAI_BASE_URL` (default `https://api.openai.com`) points the embeddings elsewhere: its
end-to-end test (`test/e2e.test.ts`) runs a local stand-in that hashes words into the 1536 dimensions, so it needs
no network and no key.
