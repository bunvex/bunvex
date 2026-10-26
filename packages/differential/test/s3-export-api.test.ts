// The S3 export API (the managed OLAP export's `s3Export` log stream, STUDY-185 §2.2), on Convex's backend (the
// oracle) and on bunvex's: the bucket rules, whole tables only, the selection's shape, the update body that takes
// only the secret, the selection and the period, the stored default selection, no `prefix` key when none was
// given, `pending` on a read right after a create or an update, the second create's 409, and the dashboard's
// `listConfiguredSinks`. Neither backend writes anything to S3 (DV-570), and bunvex runs no failing worker
// (DV-571). Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`s3-export-api: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

type Answer = { status: number; body: unknown };

async function req(b: Backend, method: string, path: string, body?: unknown, auth = true): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = authOf(b);
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, body: parsed };
}

const listed = async (b: Backend) => (await req(b, "GET", "/api/v1/list_log_streams")).body as { id: string }[];

/** Delete every stream and wait until the worker removed it. */
async function clear(b: Backend) {
  for (const s of await listed(b)) await req(b, "POST", `/api/v1/delete_log_stream/${s.id}`, {});
  for (let i = 0; i < 500 && (await listed(b)).length > 0; i++) await Bun.sleep(10);
}

const base = {
  logStreamType: "s3Export",
  region: "us-east-1",
  accessKeyId: "AK",
  secretAccessKey: "SK",
  period: "hourly",
};

/** A create's answer, the stream deleted again when it was made. */
async function create(b: Backend, body: object): Promise<Answer> {
  const a = await req(b, "POST", "/api/v1/create_log_stream", body);
  if (a.status === 200) {
    await clear(b);
    return { status: 200, body: "created" };
  }
  return a;
}

/** Wait until the worker started the stream. */
async function active(b: Backend, id: string) {
  for (let i = 0; i < 500; i++) {
    const s = (await req(b, "GET", `/api/v1/get_log_stream/${id}`)).body as { status: { type: string } };
    if (s.status.type === "active") return;
    await Bun.sleep(2);
  }
  throw new Error(`${b.name}: ${id} never became active`);
}

/** Ids, as each backend makes its own. */
function sameIds(v: unknown, id: string): unknown {
  return JSON.parse(JSON.stringify(v).replaceAll(id, "<id>"));
}

const CREATES: [string, object][] = [
  // The bucket: AWS's rules, an IPv4 address (as Rust parses one) and the reserved prefixes and suffixes.
  ...[
    "192.168.1.1",
    "0.0.0.0",
    "1.2.3.04",
    "01.2.3.4",
    "256.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "xn--abc",
    "sthree-abc",
    "abc-s3alias",
    "abc--ol-s3",
    "xn-abc",
    "sthree",
    "abc-s3alia",
    "ab",
    "a..b",
    "Abc",
    "a.-b",
  ].map((bucket): [string, object] => [`bucket ${bucket}`, { ...base, bucket }]),
  // Whole tables only.
  [
    "a column left out",
    { ...base, bucket: "bkt", selection: { _other: "excl", "": { _other: "excl", t: { _other: "incl", c: "excl" } } } },
  ],
  [
    "a table's other columns left out",
    {
      ...base,
      bucket: "bkt",
      selection: { _other: "incl", "": { _other: "incl", t: { _other: "excluded", a: "included" } } },
    },
  ],
  [
    "every column named",
    { ...base, bucket: "bkt", selection: { _other: "incl", "": { _other: "incl", t: { _other: "incl", a: "incl" } } } },
  ],
  [
    "a component left out",
    { ...base, bucket: "bkt", selection: { _other: "included", c: "excluded", "": { _other: "excluded" } } },
  ],
  [
    "a bad bucket and a filter",
    { ...base, bucket: "ab", selection: { _other: "incl", "": { _other: "incl", t: { _other: "excl" } } } },
  ],
  // The selection's shape.
  ["no _other", { ...base, bucket: "bkt", selection: { "": "included" } }],
  ["an included component", { ...base, bucket: "bkt", selection: { _other: "included", "": "included" } }],
  [
    "an included table",
    { ...base, bucket: "bkt", selection: { _other: "incl", "": { _other: "incl", t: "included" } } },
  ],
  [
    "a bad column",
    { ...base, bucket: "bkt", selection: { _other: "incl", "": { _other: "incl", t: { _other: "incl", c: "x" } } } },
  ],
  ["a bad _other", { ...base, bucket: "bkt", selection: { _other: "maybe" } }],
  ["a bad component, then a bad _other", { ...base, bucket: "bkt", selection: { c: 5, _other: "bad" } }],
  ["_other: 5", { ...base, bucket: "bkt", selection: { _other: 5 } }],
  ["_other: null", { ...base, bucket: "bkt", selection: { _other: null } }],
  ["_other: []", { ...base, bucket: "bkt", selection: { _other: [] } }],
  ["_other: {}", { ...base, bucket: "bkt", selection: { _other: {} } }],
  ["_other as a map", { ...base, bucket: "bkt", selection: { _other: { included: null } } }],
  ["_other as a map with a value", { ...base, bucket: "bkt", selection: { _other: { included: 1 } } }],
  ["_other as a map of an unknown variant", { ...base, bucket: "bkt", selection: { _other: { x: null } } }],
  ["_other as a map of two", { ...base, bucket: "bkt", selection: { _other: { included: null, excluded: null } } }],
  [
    "tags as maps",
    {
      ...base,
      bucket: "bkt",
      selection: { _other: "incl", c: { excl: null }, "": { _other: "incl", t: { excluded: null } } },
    },
  ],
  [
    "a column filter as maps",
    {
      ...base,
      bucket: "bkt",
      selection: { _other: "incl", "": { _other: "incl", t: { _other: { included: null }, a: { excluded: null } } } },
    },
  ],
  ["selection 5", { ...base, bucket: "bkt", selection: 5 }],
  ["selection []", { ...base, bucket: "bkt", selection: [] }],
  ["selection a string", { ...base, bucket: "bkt", selection: "x" }],
  ["selection true", { ...base, bucket: "bkt", selection: true }],
  ["selection 1.5", { ...base, bucket: "bkt", selection: 1.5 }],
  ["selection and prefix null", { ...base, bucket: "bkt", selection: null, prefix: null }],
  // The other fields: in the body's order, then the missing ones; unknown fields are ignored.
  ["period 5", { ...base, bucket: "bkt", period: 5 }],
  ["period as a map", { ...base, bucket: "bkt", period: { daily: null } }],
  ["period {}", { ...base, bucket: "bkt", period: {} }],
  ["period null", { ...base, bucket: "bkt", period: null }],
  ["a bad period, then a bad bucket", { logStreamType: "s3Export", period: "bad", bucket: 5 }],
  ["a bad bucket, then a bad period", { logStreamType: "s3Export", bucket: 5, period: "bad" }],
  ["bucket missing", { logStreamType: "s3Export", region: "r" }],
  ["secretAccessKey missing", { logStreamType: "s3Export", bucket: "bkt", region: "r", accessKeyId: "a" }],
  ["prefix 5", { ...base, bucket: "bkt", prefix: 5 }],
  ["bucket null", { ...base, bucket: null }],
  ["an unknown field", { ...base, bucket: "bkt", foo: 1 }],
  // Another type's `null` where a string goes (the same reading of the body).
  ["a webhook's url null", { logStreamType: "webhook", url: null, format: "json" }],
];

const MADE = {
  ...base,
  bucket: "bkt",
  selection: { _other: "incl", "": { _other: "excl", Users: "excl", posts: { _other: "incl" } }, B: "excl" },
};

const UPDATES: [string, object][] = [
  ["region", { region: "eu-west-1" }],
  ["bucket and period", { period: "daily", bucket: "other" }],
  ["prefix", { prefix: "x" }],
  ["accessKeyId", { accessKeyId: "x" }],
  ["an unknown field", { foo: 1 }],
  ["a bad period, then a bucket", { period: "weekly", bucket: "x" }],
  ["a bad selection, then a region", { selection: { _other: "x" }, region: "r" }],
  ["a region, then a bad selection", { region: "r", selection: { _other: "x" } }],
  ["period 5", { period: 5 }],
  ["secretAccessKey 5", { secretAccessKey: 5 }],
  ["selection 5", { selection: 5 }],
  ["a column filter", { selection: { _other: "incl", "": { _other: "incl", t: { _other: "excl" } } } }],
  ["another type's fields", { logStreamType: "webhook", url: "https://example.com" }],
  ["nulls keep each field", { period: null, secretAccessKey: null, selection: null }],
  [
    "the secret, the selection and the period",
    {
      period: "daily",
      secretAccessKey: "S2",
      selection: { _other: "excl", "": { _other: "excl", t: "excl", u: { _other: "incl" } } },
    },
  ],
];

describe.skipIf(!ready)("the S3 export API on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()] as const);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("create: the bucket rules, whole tables, the body's shape", async () => {
    for (const [name, body] of CREATES) {
      const c = await create(convex, body);
      const b = await create(bunvex, body);
      expect({ name, ...b }).toEqual({ name, ...c });
    }
    // The rows STUDY-185 §2.2 measured, as Convex answers them.
    const rules = Object.fromEntries(
      await Promise.all(
        ["192.168.1.1", "xn--abc", "abc-s3alias", "ab", "1.2.3.04"].map(async (bucket) => [
          bucket,
          (await create(bunvex, { ...base, bucket })).body,
        ]),
      ),
    );
    expect(rules["192.168.1.1"]).toEqual({
      code: "InvalidS3Bucket",
      message: "`192.168.1.1` is not a valid S3 bucket name",
    });
    expect((rules["xn--abc"] as { code: string }).code).toBe("InvalidS3Bucket");
    expect((rules["abc-s3alias"] as { code: string }).code).toBe("InvalidS3Bucket");
    expect(rules["1.2.3.04"]).toBe("created");
  }, 120_000);

  test("created: listed, pending then active; a second create; updates; the dashboard's list", async () => {
    const transcript = async (b: Backend) => {
      await clear(b);
      const out: Record<string, unknown> = {};
      const made = await req(b, "POST", "/api/v1/create_log_stream", MADE);
      const id = (made.body as { id: string }).id;
      out.create = made;
      // Right after the create: `pending` (the worker runs from the commit's subscription), then `active`.
      out.listed = await req(b, "GET", "/api/v1/list_log_streams");
      await active(b, id);
      out.active = await req(b, "GET", `/api/v1/get_log_stream/${id}`);
      out.second = await req(b, "POST", "/api/v1/create_log_stream", { ...MADE, bucket: "other" });
      for (const [name, body] of UPDATES) {
        out[`update: ${name}`] = await req(b, "POST", `/api/v1/update_log_stream/${id}`, {
          logStreamType: "s3Export",
          ...body,
        });
        out[`after: ${name}`] = await req(b, "GET", `/api/v1/get_log_stream/${id}`);
      }
      // The body is read before the key, and before the id is looked up.
      out["no key"] = await req(
        b,
        "POST",
        `/api/v1/update_log_stream/${id}`,
        { logStreamType: "s3Export", region: "r" },
        false,
      );
      out["no such id"] = await req(b, "POST", "/api/v1/update_log_stream/nope", {
        logStreamType: "s3Export",
        region: "r",
      });
      await active(b, id);
      const sinks = await req(b, "POST", "/api/query", {
        path: "_system/frontend/listConfiguredSinks",
        args: {},
        format: "json",
      });
      for (const s of (sinks.body as { value: { _creationTime?: number }[] }).value) delete s._creationTime;
      out.listConfiguredSinks = sinks;
      // With a prefix: listed.
      await clear(b);
      const withPrefix = await req(b, "POST", "/api/v1/create_log_stream", { ...base, bucket: "bkt", prefix: "" });
      const prefixId = (withPrefix.body as { id: string }).id;
      out.prefix = await req(b, "GET", `/api/v1/get_log_stream/${prefixId}`);
      await clear(b);
      return sameIds(sameIds(out, id), prefixId) as Record<string, Answer>;
    };
    const c = await transcript(convex);
    const b = await transcript(bunvex);
    // Selections compared as text: Convex lists each level's entries in byte order, then `_other`.
    expect(JSON.stringify(b, null, 1)).toBe(JSON.stringify(c, null, 1));
    // What STUDY-185 §2.2 measured, on both.
    const first = (c.listed.body as Record<string, unknown>[])[0]!;
    expect([first.status, first.selection, "prefix" in first]).toEqual([
      { type: "pending" },
      {
        "": { Users: "excluded", posts: { _other: "included" }, _other: "excluded" },
        B: "excluded",
        _other: "included",
      },
      false,
    ]);
    expect((c.active.body as { status: unknown }).status).toEqual({ type: "active" });
    expect((c.second.body as { code: string }).code).toBe("LogStreamAlreadyExists");
    expect(c["update: region"]!.body).toEqual({
      code: "BadJsonBody",
      message:
        "Failed to deserialize the JSON body into the target type: unknown field `region`, expected one of `secretAccessKey`, `selection`, `period`",
    });
  }, 120_000);
});
