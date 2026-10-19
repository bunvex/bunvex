// STUDY-168 microbenchmark peer (transport-bench.ts): answers each op with a document, over the transport MODE names.
import { connect } from "node:net";
import { FrameReader, frame } from "./framing.ts";

const doc = {
  _id: "jd7a2k4n9g8w3v5e6r1t0y2u3i4o5p6a",
  _creationTime: 1760000000000.5,
  tenantId: "t0",
  title: "item 1 of tenant 0",
  status: "open",
  amount: 4242,
  createdAt: 1760000000000,
};
const answer = (m: { call: number; op: number }) => ({ t: "result", call: m.call, op: m.op, value: doc });
const mode = process.env.MODE;

if (mode === "worker") {
  (globalThis as unknown as Worker).onmessage = (e: MessageEvent) => postMessage(answer(e.data));
} else if (mode === "ipc") {
  process.on("message", (m) => process.send?.(answer(m as { call: number; op: number })));
  process.send?.("ready");
} else if (mode === "stdio") {
  const out = Bun.stdout.writer();
  const reader = new FrameReader((m) => {
    out.write(frame(answer(m as { call: number; op: number })));
    out.flush();
  });
  for await (const chunk of Bun.stdin.stream()) reader.push(chunk);
} else if (mode === "socket") {
  const sock = connect(process.env.SOCK as string);
  sock.setNoDelay(true);
  const reader = new FrameReader((m) => sock.write(frame(answer(m as { call: number; op: number }))));
  sock.on("data", (d) => reader.push(d as Uint8Array));
  // The host hung up: exit, so a container running this stops too (container-rtt.ts).
  sock.on("close", () => process.exit(0));
}
