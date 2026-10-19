import { hello, requests, write } from "./fake.ts";

await hello();
// A header that says 200 MiB; the body never comes, and the host must not wait for it.
await requests(async () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, 200 * 1024 * 1024, true);
  await write(header);
  setInterval(() => {}, 1000);
});
