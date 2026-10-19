import { hello, requests, send } from "./fake.ts";

await hello();
// Answers with its own environment's names, as an error's message.
await requests((m) =>
  send({ t: "failed", id: m.id, error: { kind: "Error", message: JSON.stringify(Object.keys(process.env).sort()) } }),
);
