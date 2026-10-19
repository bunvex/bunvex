import { hello, requests, send } from "./fake.ts";

await hello();
await requests((m) => send({ t: "failed", id: m.id + 1000, error: { kind: "Error", message: "no one asked" } }));
