// Closes its socket with a request of the host's still unread, so the host's next read fails (ECONNRESET on Linux,
// the end of the stream on macOS) while the child lives on: the broken socket, not the exit, is what the host sees
// first.
import { closeSync, fstatSync } from "node:fs";
import { hello } from "./fake.ts";

await hello();
// The host's request lands meanwhile, and stays unread.
await Bun.sleep(100);
process.stderr.write("the child dropped its channel\n");
// Every descriptor of the socket: Bun may hold copies of fd 3 of its own.
const socket = fstatSync(3);
for (let fd = 3; fd < 256; fd++) {
  try {
    const s = fstatSync(fd);
    if (s.dev === socket.dev && s.ino === socket.ino) closeSync(fd);
  } catch {}
}
await Bun.sleep(10_000);
