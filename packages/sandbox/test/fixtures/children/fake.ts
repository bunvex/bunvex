// Children that misbehave, for host.test.ts: each file is one child, `SandboxProcess.start({ entry })`. They speak
// the frames directly, so they can break them.
import { FrameReader, frame } from "../../../src/frames.ts";
import { PROTOCOL_VERSION } from "../../../src/protocol.ts";

const out = Bun.file(3).writer();
export function write(bytes: Uint8Array) {
  out.write(bytes);
  return out.flush();
}
export const send = (m: unknown) => write(frame(m));
export const hello = (protocol = PROTOCOL_VERSION) => send({ t: "hello", protocol, pid: process.pid });

/** Calls `on` with each request the host sends. */
export async function requests(on: (m: { t: string; id: number }) => unknown) {
  const reader = new FrameReader();
  for await (const chunk of Bun.file(3).stream())
    for (const text of reader.push(chunk))
      if (typeof text === "string") await on(JSON.parse(text) as { t: string; id: number });
}
