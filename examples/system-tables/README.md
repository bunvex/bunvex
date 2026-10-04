# System tables

bunvex keeps some of its own data in system tables a function can read with `ctx.db.system`:

- `_storage`: each uploaded file's size, SHA-256 and content type. `admin.files` joins it with the app's
  `uploads` table (who uploaded what).
- `_scheduled_functions`: each scheduled call and its state (`pending`, `inProgress`, `success`, `failed`,
  `canceled`). `messages.sendLater` schedules a send; `admin.scheduledSends` lists them, live, and
  `admin.cancelSend` cancels one that has not run.

```sh
bun install
bun run dev
```

Its end-to-end test (`test/e2e.test.ts`) uploads a file and reads its metadata back, cancels a scheduled send,
and follows another to `success`.
