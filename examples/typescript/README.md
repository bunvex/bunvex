# TypeScript

Types end to end. `bunvex/schema.ts` declares the `messages` table; codegen turns it into `Doc<"messages">` and
`Id<"messages">` (`bunvex/_generated/dataModel`), which type `ctx.db` in the functions. `list` returns
`Doc<"messages">[]`, so `useQuery(api.messages.list)` in `src/App.tsx` is `Doc<"messages">[] | undefined`, and
`useMutation(api.messages.send)` takes exactly `send`'s arguments.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions (typechecked), opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it with the typecheck on, and builds the front end against
the generated types.
