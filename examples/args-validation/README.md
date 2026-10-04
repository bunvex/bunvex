# Argument validation

`bunvex/messages.ts` declares what each function takes and returns with validators (`v.string()`,
`v.optional(v.array(v.string()))`, `returns: v.null()`, `returns: v.number()`). A call the `args` validators
refuse — a missing field, a field of the wrong type, an extra field — is rejected with an
`ArgumentValidationError` before the handler runs, so nothing is written. The page shows the error.

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) deploys it and makes valid and invalid calls through the client.
