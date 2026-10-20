// The real child, with its operations forged as a compromised child would send them (STUDY-171 §8.3, §12): in place
// of each `ctx.auth.getUserIdentity()`, what `mode` says (each `forge-<mode>.ts` starts one). The host must refuse each.
export type ForgeMode =
  | "insert"
  | "unknownOp"
  | "otherCall"
  | "badTag"
  | "tooManyArgs"
  | "longLine"
  | "badLevel"
  | "auditNotJson"
  // An action's: bytes for a stream the host never opened, a cut-off it never asked for, a file of another size
  // than it says, a `fetch` with no input.
  | "chunk"
  | "cancelled"
  | "fileSize"
  | "fetchNoInput";

export async function forge(mode: ForgeMode) {
  const realFile = Bun.file;
  const forged = (m: Record<string, unknown>): Record<string, unknown> => {
    if (m.t !== "op" || m.name !== "auth.getUserIdentity") return m;
    if (mode === "insert") return { ...m, name: "db.insert", args: ["items", { forged: true }] };
    if (mode === "unknownOp") return { ...m, name: "process.exit", args: [] };
    if (mode === "otherCall") return { ...m, id: 999_999 };
    if (mode === "badTag") return { ...m, name: "db.get", args: [{ $evil: 1 }] };
    if (mode === "tooManyArgs") return { ...m, name: "db.get", args: [1, 2, 3, 4, 5, 6] };
    const report = m.report as Record<string, unknown>;
    // A line past the cut the console makes, said not to be cut.
    if (mode === "longLine")
      return { ...m, report: { ...report, lines: [["LOG", ["z".repeat(100_000)], false, Date.now()]] } };
    if (mode === "badLevel") return { ...m, report: { ...report, lines: [["TRACE", ["x"], false, Date.now()]] } };
    if (mode === "auditNotJson") return { ...m, name: "log.audit", args: ["not json"] };
    if (mode === "cancelled") return { t: "cancelled", id: m.id };
    if (mode === "fileSize") return { ...m, name: "storage.store", args: [{ type: "", size: 5, b: { $b: "AQID" } }] };
    if (mode === "fetchNoInput") return { ...m, name: "fetch", args: [{}] };
    return m;
  };
  const CHUNK_FLAG = 0x8000_0000;
  (Bun as { file: unknown }).file = (fd: number, ...rest: unknown[]) => {
    const f = (realFile as (...a: unknown[]) => ReturnType<typeof Bun.file>)(fd, ...rest);
    if (fd !== 3) return f;
    return new Proxy(f, {
      get(target, p) {
        if (p !== "writer") {
          const value = Reflect.get(target, p, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return () => {
          const w = target.writer();
          return {
            write(bytes: Uint8Array) {
              // A stream's chunk goes as it is.
              if ((new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) & CHUNK_FLAG) !== 0)
                return w.write(bytes);
              const text = new TextDecoder().decode(bytes.subarray(4));
              const m = JSON.parse(text);
              if (mode === "chunk" && m.t === "op" && m.name === "auth.getUserIdentity") {
                // Bytes for stream 77, which the host never opened.
                const chunk = new Uint8Array(4 + 4 + 3);
                const view = new DataView(chunk.buffer);
                view.setUint32(0, (CHUNK_FLAG | 7) >>> 0, true);
                view.setUint32(4, 77, true);
                return w.write(chunk);
              }
              const out = new TextEncoder().encode(JSON.stringify(forged(m)));
              const framed = new Uint8Array(4 + out.length);
              new DataView(framed.buffer).setUint32(0, out.length, true);
              framed.set(out, 4);
              return w.write(framed);
            },
            flush: () => w.flush(),
          };
        };
      },
    });
  };
  await import("../../../src/child.ts");
}
