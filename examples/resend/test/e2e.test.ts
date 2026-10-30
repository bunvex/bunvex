// The resend example end to end, without reaching Resend: the component installed from the workspace; test mode's
// refusal; an email queued and canceled before its batch; an email the app's own code sent, tracked, then followed
// through Resend's webhook with payloads the test signs (statuses, the open flag, the events heard); a payload with a
// bad signature refused. The front end typechecks and builds.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR, { env: { RESEND_API_KEY: "re_not_a_real_key", RESEND_WEBHOOK_SECRET: SECRET } });
});
afterAll(() => d?.stop());

type Row = { emailId: string; to: string; status: string; opened: boolean; events: string[] };
const list = async () => (await d.http.query(api.emails.list, {})) as Row[];

/** Resend's webhook request for `event`, signed as Svix signs it with the deployment's secret. */
async function webhook(event: unknown, secret = SECRET) {
  const body = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return fetch(`${d.siteUrl}/resend-webhook`, {
    method: "POST",
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${Buffer.from(mac).toString("base64")}`,
    },
  });
}

test("test mode refuses an ordinary address; a queued email canceled before its batch never goes out", async () => {
  await expect(
    d.http.mutation(api.emails.send, { to: "someone@example.com", subject: "s", text: "t" }),
  ).rejects.toThrow("test");
  const emailId = await d.http.mutation(api.emails.send, { to: "delivered@resend.dev", subject: "later", text: "t" });
  await d.http.mutation(api.emails.cancel, { emailId });
  // Past the batch's second: still canceled, never sent.
  await Bun.sleep(2_000);
  expect((await list()).find((r) => r.emailId === emailId)?.status).toBe("cancelled");
});

test("an email the app sent itself, followed through the webhook: delivered, opened, and every event heard", async () => {
  const emailId = (
    await d.cli(
      "run",
      "emails:trackSent",
      JSON.stringify({ to: "b@example.com", subject: "own", resendId: "re_e2e_1" }),
    )
  )
    .trim()
    .replaceAll('"', "");
  expect((await list()).find((r) => r.emailId === emailId)?.status).toBe("sent");
  const common = {
    email_id: "re_e2e_1",
    created_at: "2026-10-30T12:00:00.000Z",
    from: "a@example.com",
    to: ["b@example.com"],
    subject: "own",
  };
  const at = "2026-10-30T12:00:01.000Z";
  expect((await webhook({ type: "email.delivered", created_at: at, data: common })).status).toBe(201);
  expect(
    (
      await webhook({
        type: "email.opened",
        created_at: at,
        data: { ...common, open: { ipAddress: "1.2.3.4", timestamp: at, userAgent: "ua" } },
      })
    ).status,
  ).toBe(201);
  // The callbacks run on the component's callback pool, after the route answered.
  let row: Row | undefined;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(100)) {
    row = (await list()).find((x) => x.emailId === emailId);
    if (row && row.events.length === 2) break;
  }
  if (!row) throw new Error("the email is gone");
  expect(row).toMatchObject({ status: "delivered", opened: true });
  expect([...row.events].sort()).toEqual(["email.delivered", "email.opened"]);
});

test("a payload with a bad signature is refused and changes nothing", async () => {
  const before = await list();
  const r = await webhook(
    { type: "email.bounced", created_at: "x", data: { email_id: "re_e2e_1" } },
    "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  expect(r.status).toBe(500);
  expect(await list()).toEqual(before);
});

test("the front end typechecks and builds", () => build(DIR), 120_000);
