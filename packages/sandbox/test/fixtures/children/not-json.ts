import { hello, requests, write } from "./fake.ts";

await hello();
await requests(async () => {
  const body = new TextEncoder().encode("{not json");
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.byteLength, true);
  await write(header);
  await write(body);
});
