// The email component (STUDY-200) on Convex's backend (the oracle) with `@convex-dev/resend` 0.2.10, and on bunvex's
// with `@bunvex/resend`, without reaching Resend: the same app (resend-app/) makes the same calls on both. It compares:
// - `sendEmail`'s refusals and, for each accepted email, its status queued, its status once canceled and its row;
// - the idempotency key's dedupe;
// - the webhook route end to end, with payloads signed with the app's `whsec_` secret: the HTTP status of each, the
//   email's status and flags after each event, and the `onEmailEvent` callbacks, in order;
// - the webhook's refusals (a bad or missing signature).
// The request to Resend itself is compared by its parts in components/resend's own tests. Local only: skipped, with a
// note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`resend: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../resend-app");
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
let convex: Backend;
let bunvex: Backend;

/** bunvex's project installs `@bunvex/resend` where Convex's has `@convex-dev/resend`. */
function prepare(project: string, dir: "convex" | "bunvex") {
  if (dir !== "bunvex") return;
  const functions = join(project, dir);
  renameSync(join(functions, "convex.config.ts"), join(functions, "bunvex.config.ts"));
  for (const name of ["bunvex.config.ts", "emails.ts"]) {
    const file = join(functions, name);
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replaceAll('"@convex-dev/resend/convex.config"', '"@bunvex/resend/bunvex.config.js"')
        .replaceAll('"@convex-dev/resend"', '"@bunvex/resend"'),
    );
  }
}

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 300_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const value = async (b: Backend, kind: "query" | "mutation", path: string, args: Record<string, unknown>) => {
  const r = await b.call(kind, path, args);
  if (!r.ok) throw new Error(`${b.name}: call failed: ${JSON.stringify(r.body)}`);
  return (r.body as { value: unknown }).value;
};

/** Svix's signature of `body`: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` under the secret's bytes. */
async function signed(body: string, id = `msg_${crypto.randomUUID()}`, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(SECRET.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${Buffer.from(mac).toString("base64")}`,
  };
}
const webhook = async (b: Backend, body: string, headers: Record<string, string>) => {
  const r = await fetch(`${b.url}/http/resend-webhook`, { method: "POST", body, headers });
  return { status: r.status, body: r.status < 400 ? await r.text() : null };
};

const BASE = { from: "Sender <sender@example.com>", subject: "Hello", html: "<p>hi</p>" };
const SENDS: { options: Record<string, unknown>; testMode?: boolean }[] = [
  { options: { ...BASE, to: "delivered@resend.dev" } },
  { options: { ...BASE, to: ["delivered@resend.dev", "bounced@resend.dev"], text: "hi" } },
  {
    options: {
      ...BASE,
      to: "delivered+label@resend.dev",
      cc: ["delivered@resend.dev"],
      bcc: "delivered@resend.dev",
      replyTo: ["reply@example.com"],
      headers: [{ name: "X-Tag", value: "1" }],
    },
  },
  { options: { ...BASE, to: "someone@example.com" } },
  { options: { ...BASE, to: "someone@example.com" }, testMode: false },
  { options: { from: "s@example.com", to: "delivered@resend.dev", subject: "no body" } },
  { options: { ...BASE, to: [] } },
];

describe.skipIf(!ready)("the email component: Convex with @convex-dev/resend 0.2.10, bunvex with ours", () => {
  test("sendEmail: refusals, statuses queued and canceled, the stored row; the idempotency key's dedupe", async () => {
    const run = async (b: Backend) => {
      const out: unknown[] = [];
      for (const s of SENDS) out.push(await value(b, "mutation", "emails:sendAndCancel", s));
      out.push(await value(b, "mutation", "emails:dedupe", {}));
      return out;
    };
    expect(await run(bunvex)).toEqual(await run(convex));
  });

  test("the webhook: each event's answer, the email's status and flags after it, and the callbacks in order", async () => {
    const run = async (b: Backend) => {
      const id = (await value(b, "mutation", "emails:manual", { resendId: "re_diff_1" })) as string;
      const common = {
        email_id: "re_diff_1",
        created_at: "2026-10-30T12:00:00.000Z",
        from: "a@example.com",
        to: ["b@example.com"],
        subject: "manual",
      };
      const at = "2026-10-30T12:00:01.000Z";
      const events = [
        { type: "email.sent", created_at: at, data: common },
        { type: "email.delivery_delayed", created_at: at, data: common },
        { type: "email.delivered", created_at: at, data: common },
        {
          type: "email.opened",
          created_at: at,
          data: { ...common, open: { ipAddress: "1.2.3.4", timestamp: at, userAgent: "ua" } },
        },
        {
          type: "email.clicked",
          created_at: at,
          data: { ...common, click: { ipAddress: "1.2.3.4", link: "https://x", timestamp: at, userAgent: "ua" } },
        },
        { type: "email.complained", created_at: at, data: common },
        {
          type: "email.bounced",
          created_at: at,
          data: { ...common, bounce: { message: "gone", subType: "General", type: "Permanent" } },
        },
        { type: "email.failed", created_at: at, data: { ...common, failed: { reason: "after the bounce" } } },
        { type: "email.unknown_kind", created_at: at, data: common },
        { type: "email.delivered", created_at: at, data: { ...common, email_id: "re_nobody" } },
      ];
      const steps: unknown[] = [];
      for (const e of events) {
        const body = JSON.stringify(e);
        const answer = await webhook(b, body, await signed(body));
        steps.push({ type: e.type, answer, after: await value(b, "query", "emails:email", { id }) });
      }
      // The callbacks run on the component's callback pool, after the route answered.
      const deadline = Date.now() + 30_000;
      let callbacks: unknown[] = [];
      while (Date.now() < deadline) {
        callbacks = (await value(b, "query", "emails:events", {})) as unknown[];
        if (callbacks.length >= 8) break;
        await Bun.sleep(200);
      }
      await Bun.sleep(1_000);
      callbacks = (await value(b, "query", "emails:events", {})) as unknown[];
      return { steps, callbacks };
    };
    const [c, x] = await Promise.all([run(convex), run(bunvex)]);
    expect(x.steps).toEqual(c.steps);
    // Each pool runs its callbacks in parallel, so their order is each backend's: compared as a multiset.
    const sorted = (a: unknown[]) => a.map((e) => JSON.stringify(e)).sort();
    expect(sorted(x.callbacks)).toEqual(sorted(c.callbacks));
  }, 120_000);

  test("the webhook's refusals: a bad signature, a missing header, an old timestamp", async () => {
    const run = async (b: Backend) => {
      const body = JSON.stringify({ type: "email.sent", created_at: "x", data: {} });
      const good = await signed(body);
      return [
        await webhook(b, body, { ...good, "svix-signature": "v1,AAAA" }),
        await webhook(b, body, { "svix-id": good["svix-id"], "svix-signature": good["svix-signature"] }),
        await webhook(b, body, await signed(body, undefined, Math.floor(Date.now() / 1000) - 3600)),
      ];
    };
    expect(await run(bunvex)).toEqual(await run(convex));
  });
});
