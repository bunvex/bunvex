# File storage

A chat that sends images. Uploading is three steps (`src/App.tsx`): `generateUploadUrl` gives a short-lived URL,
the browser POSTs the file to it and gets a `storageId` back, and `sendImage` saves that id in a message.
`list` turns each image message's id into the URL its file is served at, with `ctx.storage.getUrl`.

```sh
bun install
bun run dev   # starts a local deployment, pushes the functions, opens the page
```

Its end-to-end test (`test/e2e.test.ts`) deploys it to a fresh backend and checks the same behaviour through
the client.
