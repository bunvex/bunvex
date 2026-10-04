# Custom errors

Functions throw `BunvexError` (from `bunvex/values`) for errors the app expects, with data: `send` refuses a
message over 50 characters with a string, and `list` fails past 20 messages with an object
(`{ code, message, count }`). The client receives that data as it was thrown: the page shows the mutation's
string, and an error boundary shows the query's object with a button that clears the messages. Any other
error reaches the client without its details.

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) checks both errors' data through the client, the query's on a live
subscription.
