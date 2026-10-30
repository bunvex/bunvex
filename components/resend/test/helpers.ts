// What the component tests share (upstream's `src/component/setup.test.ts`, ported): a deployment of the component's
// functions pushed as an app's (fixtures/standalone, which mounts the component's children), a fixture event of each
// type, the runtime options, and rows inserted directly; plus the console capture and a Svix signer of the tests' own.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import type { EventEventOfType, EventEventTypes, RuntimeConfig } from "../src/component/shared.ts";
import { assertExhaustive } from "../src/component/utils.ts";

export const api = anyApi as any;
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

/** A fresh deployment of the component's functions, closed after the test. */
export function setupTest(opts: { outboundFetch?: (r: Request) => Response | Promise<Response> } = {}): TestBunvex {
  const t = bunvexTest({ cwd: STANDALONE, ...opts });
  open.push(t);
  return t;
}
export type Tester = TestBunvex;

/** A fixture event of `type`, with `overrides` (its `data` merged into the fixture's). */
export function createTestEventOfType<T extends EventEventTypes>(
  type: T,
  overrides?: Partial<EventEventOfType<T>>,
): EventEventOfType<T> {
  const data = {
    email_id: "test-resend-id-123",
    message_id: "<test-message-id@example.com>",
    created_at: "2024-01-01T00:00:00Z",
    from: "test@example.com",
    to: "recipient@example.com",
    subject: "Test Email",
    broadcast_id: "test-broadcast-123",
    cc: ["cc@example.com"],
    bcc: ["bcc@example.com"],
    reply_to: ["reply@example.com"],
    headers: [{ name: "X-Test-Header", value: "test-value" }],
    tags: [
      { name: "environment", value: "test" },
      { name: "campaign", value: "test-campaign" },
    ],
  };
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const extra = (): Record<string, unknown> => {
    switch (type as EventEventTypes) {
      case "email.sent":
      case "email.delivered":
      case "email.delivery_delayed":
      case "email.complained":
        return {};
      case "email.bounced":
        return { bounce: { message: "The email bounced due to invalid recipient", subType: "general", type: "hard" } };
      case "email.opened":
        return { open: { ipAddress: "192.168.1.100", timestamp: "2024-01-01T00:05:00Z", userAgent } };
      case "email.clicked":
        return {
          click: {
            ipAddress: "192.168.1.100",
            link: "https://example.com/test-link",
            timestamp: "2024-01-01T00:10:00Z",
            userAgent,
          },
        };
      case "email.failed":
        return { failed: { reason: "SMTP server rejected the email" } };
      default:
        return assertExhaustive(type as never);
    }
  };
  const event = { type, created_at: "2024-01-01T00:00:00Z", data: { ...data, ...extra() } };
  if (!overrides) return event as unknown as EventEventOfType<T>;
  return {
    ...event,
    ...overrides,
    data: overrides.data ? { ...event.data, ...overrides.data } : event.data,
  } as unknown as EventEventOfType<T>;
}

export const createTestRuntimeConfig = (): RuntimeConfig => ({
  apiKey: "test-api-key",
  testMode: true,
  initialBackoffMs: 1000,
  retryAttempts: 3,
});

/** The `lastOptions` row, as a sender would have left it. */
export const setupTestLastOptions = (t: Tester, overrides?: Partial<Doc<"lastOptions">>) =>
  t.run(async (ctx: any) => {
    await ctx.db.insert("lastOptions", { options: { ...createTestRuntimeConfig() }, ...overrides });
  });

/** An email row inserted as given. */
export const insertTestEmail = (t: Tester, fields: Omit<Doc<"emails">, "_id" | "_creationTime">) =>
  t.run(async (ctx: any) => {
    const id = await ctx.db.insert("emails", fields);
    const email = await ctx.db.get("emails", id);
    if (!email) throw new Error("Email not found");
    return email as Doc<"emails">;
  });

/** A `sent` email with Resend's id `test-resend-id-123`, as `onEmailComplete` leaves one. */
export const insertTestSentEmail = (t: Tester, overrides?: Partial<Doc<"emails">>) =>
  insertTestEmail(t, {
    from: "test@example.com",
    to: "recipient@example.com",
    subject: "Test Email",
    replyTo: [],
    status: "sent",
    bounced: false,
    complained: false,
    failed: false,
    deliveryDelayed: false,
    opened: false,
    clicked: false,
    resendId: "test-resend-id-123",
    segment: 1,
    finalizedAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  });

/** An email row by id. */
export const getEmail = (t: Tester, id: Id<"emails">) =>
  t.run((ctx: any) => ctx.db.get("emails", id)) as Promise<Doc<"emails"> | null>;

/** Every row of `table`. */
export const all = <T = any>(t: Tester, table: string) =>
  t.run((ctx: any) => ctx.db.query(table).collect()) as Promise<T[]>;

/** Options for `sendEmail`. */
export const options = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  apiKey: "test-key",
  initialBackoffMs: 1000,
  retryAttempts: 3,
  testMode: true,
  ...overrides,
});

/** A plain email for `lib:sendEmail`. */
export const plainEmail = (overrides: Record<string, unknown> = {}) => ({
  options: options(),
  from: "test@resend.dev",
  to: ["delivered@resend.dev"],
  subject: "Test",
  html: "<p>Test</p>",
  ...overrides,
});

/**
 * The console calls made while `fn` runs, as `level: text` lines; a deployed function's console reaches the test's.
 * Push the deployment (any call) first: the process's first push starts the function logs' sink.
 */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const levels = ["debug", "info", "log", "warn", "error"] as const;
  const saved = levels.map((l) => console[l]);
  for (const l of levels) {
    console[l] = (...args: unknown[]) => {
      lines.push(`${l}: ${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}`);
    };
  }
  try {
    return { result: await fn(), lines };
  } finally {
    levels.forEach((l, i) => {
      console[l] = saved[i] as never;
    });
  }
}

/** A Resend batch API answer for `n` emails, ids `re_1`…`re_n` (from `first`). */
export const resendOk = (n: number, first = 1) =>
  Response.json({ data: Array.from({ length: n }, (_, i) => ({ id: `re_${first + i}` })) });
