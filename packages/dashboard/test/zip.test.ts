import { describe, expect, test } from "bun:test";
import { readZip, writeZip } from "../src/mock/zip.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("the mock's zip", () => {
  test("what it writes reads back, names and bytes", async () => {
    const entries = [
      { name: "README.md", data: enc.encode("# snapshot\n") },
      { name: "tasks/documents.jsonl", data: enc.encode('{"a":1}\n{"a":2}\n') },
      { name: "_storage/x", data: new Uint8Array([0, 255, 7]) },
    ];
    const zip = writeZip(entries);
    expect(dec.decode(zip.subarray(0, 2))).toBe("PK");
    const back = await readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(back.map((e) => [...e.data])).toEqual(entries.map((e) => [...e.data]));
  });

  test("a deflated entry, as another tool writes it, reads too", async () => {
    // one entry "a.txt" = "hello hello hello", deflated (made with Bun's deflateRawSync)
    const data = enc.encode("hello hello hello");
    const deflated = Bun.deflateSync(data, { windowBits: -15 } as never);
    const zip = writeZip([{ name: "a.txt", data: deflated }]);
    // mark the entry as deflated (method 8) in the local and central headers, with the real size
    const v = new DataView(zip.buffer);
    v.setUint16(8, 8, true);
    const central = zip.length - 22 - (46 + 5);
    v.setUint16(central + 10, 8, true);
    const [e] = await readZip(zip);
    expect(dec.decode(e!.data)).toBe("hello hello hello");
  });

  test("not a zip: said in words", async () => {
    await expect(readZip(enc.encode("hello"))).rejects.toThrow("not a zip archive");
  });
});
