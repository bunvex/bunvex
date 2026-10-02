// Admin keys (STUDY-34), byte for byte Convex's. The fixtures were sealed with aws-lc-rs 1.18.1 — the library
// and version Convex's keybroker uses — through its `kbkdf_ctr_hmac` (purpose "admin key") and
// `AES_128_GCM_SIV` (AAD = [1]), with fixed nonces, from Convex's development secret and instance name
// (crates/keybroker/dev/secret.txt, instance_name.txt).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import {
  AdminKeys,
  adminKeyCipherKey,
  aes128GcmSivOpen,
  aes128GcmSivSeal,
  allows,
  BadAdminKeyError,
  checkAdminKey,
  decodeAdminKeyProto,
  encodeAdminKeyProto,
  issueAdminKey,
  READ_ONLY_OPERATIONS,
  removeTypePrefix,
} from "../src/admin-keys.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const NAME = "carnitas";
const ISSUED = 1759276800;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
/** aws-lc-rs: kbkdf_ctr_hmac(SHA256, secret, "admin key") → 16 bytes. */
const DERIVED = "a7526e1715ea4effa55636bee910d731";
/** aws-lc-rs seals (hex part only), nonce first. */
const FIX = {
  member: "01000102030405060708090a0bb87cd6b4db982701dbeace3a81361d0fe565ab4d9bb13206",
  system: "010b0a090807060504030201009d893a4540f9ba43d7642b8179e6707197f13e10eda22535",
  readOnly: "01111111111111111111111111205b3dff0977e36504bf889b8cb9a0feb5623065995425ef6be4",
  member42: "01222222222222222222222222ae1655252b6e70455955e8123653672108149d90dad25ab6",
  /** instance_name "carnitas" inside the proto, member 0: valid without a name prefix. */
  named: "013333333333333333333333331acd054c3fd6e948e4274d1eab4e0ca2fafb164dfe46ed55fa66dceb06b4cf46d512",
};
const nonceOf = (k: string) => unhex(k.slice(2, 26));
const key = adminKeyCipherKey(SECRET);

describe("the cryptography", () => {
  test("AES-128-GCM-SIV: RFC 8452 appendix C.1 vectors", () => {
    const k = unhex("01000000000000000000000000000000");
    const n = unhex("030000000000000000000000");
    const cases: [string, string, string][] = [
      ["", "", "dc20e2d83f25705bb49e439eca56de25"],
      ["", "0100000000000000", "b5d839330ac7b786578782fff6013b815b287c22493a364c"],
      ["", "010000000000000000000000", "7323ea61d05932260047d942a4978db357391a0bc4fdec8b0d106639"],
      ["01", "0200000000000000", "1e6daba35669f4273b0a1a2560969cdf790d99759abd1508"],
      [
        "",
        "01000000000000000000000000000000020000000000000000000000000000000300000000000000000000000000000004000000000000000000000000000000",
        "2433668f1058190f6d43e360f4f35cd8e475127cfca7028ea8ab5c20f7ab2af02516a2bdcbc08d521be37ff28c152bba36697f25b4cd169c6590d1dd39566d3f8a263dd317aa88d56bdf3936dba75bb8",
      ],
    ];
    for (const [aad, pt, ct] of cases) {
      expect(hex(aes128GcmSivSeal(k, n, unhex(aad), unhex(pt)))).toBe(ct);
      expect(hex(aes128GcmSivOpen(k, n, unhex(aad), unhex(ct))!)).toBe(pt);
    }
    const bad = unhex(cases[1]![2]);
    bad[0]! ^= 1;
    expect(aes128GcmSivOpen(k, n, new Uint8Array(0), bad)).toBeNull();
  });

  test('KBKDF-CTR-HMAC-SHA256 gives aws-lc\'s key for the purpose "admin key"', () => {
    expect(hex(key)).toBe(DERIVED);
  });

  test("the AdminKey proto as prost encodes it", () => {
    const p = { issuedS: ISSUED, identity: { memberId: 0 }, isReadOnly: false };
    expect(hex(encodeAdminKeyProto(p))).toBe("1080def1c6061800");
    expect(hex(encodeAdminKeyProto({ ...p, identity: { system: true } }))).toBe("1080def1c6062200");
    expect(hex(encodeAdminKeyProto({ ...p, isReadOnly: true }))).toBe("1080def1c60618002801");
    expect(decodeAdminKeyProto(unhex("0a086361726e6974617310" + "80def1c606" + "182a"))).toEqual({
      instanceName: "carnitas",
      issuedS: ISSUED,
      identity: { memberId: 42 },
      isReadOnly: false,
    });
  });
});

describe("keys interchangeable with Convex's", () => {
  test("bunvex seals exactly the bytes aws-lc sealed, given the same nonce", () => {
    const issue = (fix: string, o: object) =>
      issueAdminKey({ instanceName: NAME, cipherKey: key, issuedS: ISSUED, nonce: nonceOf(fix), ...o });
    expect(issue(FIX.member, {})).toBe(`${NAME}|${FIX.member}`);
    expect(issue(FIX.system, { system: true })).toBe(`${NAME}|${FIX.system}`);
    expect(issue(FIX.readOnly, { readOnly: true })).toBe(`${NAME}|${FIX.readOnly}`);
    expect(issue(FIX.member42, { memberId: 42 })).toBe(`${NAME}|${FIX.member42}`);
  });

  test("keys sealed by aws-lc check out as Convex's check_admin_key reads them", () => {
    expect(checkAdminKey(`${NAME}|${FIX.member}`, NAME, key)).toEqual({
      kind: "admin",
      memberId: 0,
      readOnly: false,
      allowedOps: [],
      issuedS: ISSUED,
    });
    expect(checkAdminKey(`${NAME}|${FIX.system}`, NAME, key)).toEqual({ kind: "system", issuedS: ISSUED });
    const ro = checkAdminKey(`${NAME}|${FIX.readOnly}`, NAME, key);
    expect(ro).toMatchObject({ kind: "admin", readOnly: true, allowedOps: READ_ONLY_OPERATIONS });
    expect(allows(ro, "ViewData") && !allows(ro, "WriteData") && !allows(ro, "ActAsUser")).toBe(true);
    expect(checkAdminKey(`${NAME}|${FIX.member42}`, NAME, key)).toMatchObject({ memberId: 42 });
    // No name before `|`: the name inside the key decides; a key with neither is malformed.
    expect(checkAdminKey(FIX.named, NAME, key)).toMatchObject({ kind: "admin", memberId: 0 });
    expect(() => checkAdminKey(FIX.member, NAME, key)).toThrow(BadAdminKeyError);
  });

  test("type prefixes: prod:/dev: are stripped from the name; preview:/project: keep only the key", () => {
    expect(removeTypePrefix(`prod:${NAME}|${FIX.member}`)).toBe(`${NAME}|${FIX.member}`);
    expect(removeTypePrefix(`dev:${NAME}|${FIX.member}`)).toBe(`${NAME}|${FIX.member}`);
    expect(removeTypePrefix(`preview:team:project|${FIX.named}`)).toBe(FIX.named);
    expect(removeTypePrefix(`Project:team|${FIX.named}`)).toBe(FIX.named);
    expect(removeTypePrefix(`${NAME}|${FIX.member}`)).toBe(`${NAME}|${FIX.member}`);
    // check_admin_key itself strips a type prefix off the name.
    expect(checkAdminKey(`prod:${NAME}|${FIX.member}`, NAME, key)).toMatchObject({ kind: "admin" });
  });

  test("refused with BadAdminKey: another instance, another secret, a changed byte, a bad version, garbage", () => {
    const bad = (k: string, cipher = key) => {
      try {
        checkAdminKey(k, NAME, cipher);
        return "accepted";
      } catch (e) {
        expect(e).toBeInstanceOf(BadAdminKeyError);
        expect((e as BadAdminKeyError).message).toBe("The provided admin key was invalid for this instance");
        expect((e as BadAdminKeyError).status).toBe(401);
        expect((e as BadAdminKeyError).code).toBe("BadAdminKey");
        return (e as BadAdminKeyError).reason;
      }
    };
    expect(bad(`tacos|${FIX.member}`)).toBe("Key is for invalid instance tacos");
    expect(bad(`${NAME}|${FIX.member}`, adminKeyCipherKey("00".repeat(32)))).toMatch(/does not decrypt/);
    const flipped = `${FIX.member.slice(0, 40)}${FIX.member[40] === "0" ? "1" : "0"}${FIX.member.slice(41)}`;
    expect(bad(`${NAME}|${flipped}`)).toMatch(/does not decrypt/);
    expect(bad(`${NAME}|02${FIX.member.slice(2)}`)).toMatch(/version/);
    expect(bad(`${NAME}|not-hex`)).toMatch(/not hex/);
    expect(bad(`${NAME}|01ab`)).toMatch(/too short/);
    expect(bad("")).not.toBe("accepted");
  });

  test("Convex's development admin key (the legacy secretbox format) is refused (DV-158)", () => {
    const legacy =
      "0135d8598650f8f5cb0f30c34ec2e2bb62793bc28717c8eb6fb577996d50be5f4281b59181095065c5d0f86a2c31ddbe9b597ec62b47ded69782cd";
    expect(() => checkAdminKey(`${NAME}|${legacy}`, NAME, key)).toThrow(BadAdminKeyError);
  });

  test("issued keys round-trip with random nonces, and AdminKeys caches verdicts", () => {
    const keys = new AdminKeys(NAME, key, 2);
    const a = keys.issue();
    const b = keys.issue();
    expect(a).not.toBe(b);
    expect(keys.check(a)).toMatchObject({ kind: "admin", readOnly: false });
    expect(keys.check(keys.issue({ readOnly: true }))).toMatchObject({ readOnly: true });
    expect(() => keys.check("garbage")).toThrow(BadAdminKeyError);
    expect(() => keys.check("garbage")).toThrow(BadAdminKeyError);
    expect(keys.check(b)).toMatchObject({ kind: "admin" });
  });
});

describe("the instance name", () => {
  const engines: Engine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.close();
  });
  const open = async (p: MemoryPersistence, opts: { instanceName?: string; instanceSecret?: string } = {}) => {
    const e = await new Engine(defineSchema({}), p, opts).init();
    engines.push(e);
    return e;
  };

  test("configured, else stored with the data, else bunvex-self-hosted (stored once)", async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const e = await open(p);
    expect(e.instanceName).toBe("bunvex-self-hosted");
    const named = await open(await MemoryPersistence.open(null, { durable: false }), { instanceName: NAME });
    expect(named.instanceName).toBe(NAME);
    await expect(open(await MemoryPersistence.open(null, { durable: false }), { instanceName: "a|b" })).rejects.toThrow(
      "invalid instance name",
    );
  });

  test("the engine's admin-key cipher key is Convex's for the same secret", async () => {
    const e = await open(await MemoryPersistence.open(null, { durable: false }), {
      instanceName: NAME,
      instanceSecret: SECRET,
    });
    expect(hex(e.derivedKey("admin key"))).toBe(DERIVED);
    expect(checkAdminKey(`${NAME}|${FIX.member}`, e.instanceName, e.derivedKey("admin key")).kind).toBe("admin");
  });

  test("GET /instance_name answers the name", async () => {
    const e = await open(await MemoryPersistence.open(null, { durable: false }), { instanceName: NAME });
    const server = createServer({ engine: e, functions: new Functions(e), port: 0 });
    try {
      const r = await fetch(`http://127.0.0.1:${server.server.port}/instance_name`);
      expect(await r.text()).toBe(NAME);
    } finally {
      await server.stop();
    }
  });
});
