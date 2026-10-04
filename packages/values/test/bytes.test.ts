// Base64 and UTF-8 lengths without Node's `Buffer`, as in a browser (where the client decodes every message): the
// web fallbacks give exactly what `Buffer` gives, and the client's browser bundle uses no `Buffer` at all.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as withBuffer from "../src/bytes.ts";

/** bytes.ts evaluated again with no `Buffer`, as a browser loads it. */
async function withoutBuffer(): Promise<typeof withBuffer> {
  const saved = globalThis.Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: removing the global for one import
  delete (globalThis as any).Buffer;
  try {
    return await import(`../src/bytes.ts?no-buffer=${Math.random()}`);
  } finally {
    globalThis.Buffer = saved;
  }
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const SAMPLES = ["", "a", "é", "日本", "😀", "a\u0000b", "\ud800", "x\udc00y", "😀\ud83d", "€".repeat(100)];
const randomString = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 0x10000))).join("");

describe("bytes without Buffer (a browser)", () => {
  test("base64 both ways, as Buffer", async () => {
    const web = await withoutBuffer();
    for (const n of [0, 1, 2, 3, 7, 8, 100, 0x8000 + 5, 200_000]) {
      const bytes = randomBytes(n);
      const b64 = withBuffer.toBase64(bytes);
      expect(web.toBase64(bytes)).toBe(b64);
      expect(web.fromBase64(b64)).toEqual(bytes);
      // URL-safe and unpadded input, which Node's decoder takes.
      expect(web.fromBase64(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))).toEqual(bytes);
    }
    // A view into a larger buffer: only its bytes.
    const big = randomBytes(32);
    expect(web.toBase64(big.subarray(5, 20))).toBe(withBuffer.toBase64(big.subarray(5, 20)));
  });

  test("UTF-8 lengths and order, as Buffer (lone surrogates included)", async () => {
    const web = await withoutBuffer();
    const strings = [...SAMPLES, ...Array.from({ length: 300 }, (_, i) => randomString(i % 40))];
    for (const s of strings) expect(web.utf8Length(s)).toBe(withBuffer.utf8Length(s));
    for (let i = 0; i < strings.length - 1; i++)
      expect(web.compareUtf8(strings[i]!, strings[i + 1]!)).toBe(
        Math.sign(withBuffer.compareUtf8(strings[i]!, strings[i + 1]!)),
      );
  });

  test("the client's browser bundle uses no Buffer", async () => {
    const out = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../../client/src/index.ts")],
      target: "browser",
      conditions: ["browser"],
    });
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    expect(code.match(/\bBuffer\.\w+/g) ?? []).toEqual([]);
  });
});
