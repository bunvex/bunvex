import { hello, requests, send } from "./fake.ts";

await hello();
// A version whose analysis is not a list of pairs.
await requests((m) => send({ t: "loaded", id: m.id, version: { analysis: { "m.js": {} } }, loadMs: 1 }));
