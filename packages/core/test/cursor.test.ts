// Pagination cursors sealed as Convex's keybroker seals them (STUDY-17, DV-73): the InstanceCursor proto under
// AES-128-GCM-SIV with KBKDF(secret, "cursor"), deterministic, version 7, hex.
import { expect, test } from "bun:test";
import { aes128GcmSivOpen } from "../src/aead.ts";
import { type CursorCodec, decodeCursor, encodeCursor, queryFingerprint } from "../src/cursor.ts";
import { instanceSecretBytes, kbkdfCtrHmacSha256 } from "../src/kbkdf.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const codec: CursorCodec = {
  key: kbkdfCtrHmacSha256(instanceSecretBytes(SECRET), "cursor", 16),
  instanceName: "carnitas",
};
const fp = queryFingerprint({
  tablet: "t1",
  index: "i2",
  lo: new Uint8Array([1]),
  hi: new Uint8Array([2]),
  desc: false,
});
const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString("hex");

test("the sealed bytes: version 7, then the InstanceCursor proto under the cursor key, deterministic", () => {
  const c = encodeCursor(codec, { after: new Uint8Array([0xaa, 0xbb]) }, fp);
  expect(c).toMatch(/^07[0-9a-f]+$/);
  expect(encodeCursor(codec, { after: new Uint8Array([0xaa, 0xbb]) }, fp)).toBe(c); // a zero nonce
  const bytes = new Uint8Array(Buffer.from(c, "hex"));
  const proto = aes128GcmSivOpen(codec.key, new Uint8Array(12), Uint8Array.of(7), bytes.subarray(1))!;
  // 1: "carnitas"; 2: IndexKey { 4: aabb }; 4: the fingerprint (32 bytes).
  expect(hex(proto)).toBe(`0a08${hex(Buffer.from("carnitas"))}1204` + `2202aabb` + `2220${hex(fp)}`);
  const end = encodeCursor(codec, "end", fp);
  const endProto = aes128GcmSivOpen(
    codec.key,
    new Uint8Array(12),
    Uint8Array.of(7),
    Buffer.from(end, "hex").subarray(1),
  )!;
  expect(hex(endProto)).toBe(`0a08${hex(Buffer.from("carnitas"))}1a00` + `2220${hex(fp)}`);
});

test("round trips; another query, instance or tampering is refused with Convex's errors", () => {
  const after = { after: new Uint8Array([1, 2, 3]) };
  expect(decodeCursor(codec, encodeCursor(codec, after, fp), fp)).toEqual(after);
  expect(decodeCursor(codec, encodeCursor(codec, "end", fp), fp)).toBe("end");
  const other = queryFingerprint({
    tablet: "t1",
    index: "i2",
    lo: new Uint8Array([1]),
    hi: new Uint8Array([3]),
    desc: false,
  });
  expect(() => decodeCursor(codec, encodeCursor(codec, after, fp), other)).toThrow(
    "InvalidCursor: Tried to run a query starting from a cursor, but it looks like this cursor is from a different query.",
  );
  const renamed = { ...codec, instanceName: "tacos" };
  expect(() => decodeCursor(codec, encodeCursor(renamed, after, fp), fp)).toThrow(
    'InvalidCursor: Key is invalid for instance "tacos"',
  );
  const c = encodeCursor(codec, after, fp);
  const flipped = `${c.slice(0, 10)}${c[10] === "0" ? "1" : "0"}${c.slice(11)}`;
  for (const bad of [flipped, "zz", "", `08${c.slice(2)}`, c.slice(0, -2)])
    expect(() => decodeCursor(codec, bad, fp)).toThrow("InvalidCursor: Failed to parse cursor");
  const otherSecret = { ...codec, key: kbkdfCtrHmacSha256(instanceSecretBytes(SECRET), "admin key", 16) };
  expect(() => decodeCursor(otherSecret, c, fp)).toThrow("InvalidCursor: Failed to parse cursor");
});
