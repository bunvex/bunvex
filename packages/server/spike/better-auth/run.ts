// SPIKE (STUDY-28 §3.8 step 0): better-auth (`/minimal`) hosted in the bunvex engine. Each endpoint runs as
// one bunvex execution (mutation or query) with the adapter over its transaction.
//   bun packages/server/spike/better-auth/run.ts
import { defineSchema, defineTable, Engine, withRealCrypto } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { betterAuth } from "better-auth/minimal";
import { admin, jwt } from "better-auth/plugins";
import { adapterStats, bunvexAdapter, currentTx } from "./adapter.ts";

const t = (name: string, fields: string[]) => {
  let d = defineTable(v.any());
  for (const f of fields) d = d.index(`by_${f}`, [f]);
  return [name, d] as const;
};
const tables = [
  t("user", ["email"]),
  t("session", ["token", "userId"]),
  t("account", ["userId", "accountId"]),
  t("verification", ["identifier"]),
  t("jwks", []),
  t("outbox", []),
] as const;
const indexes: Record<string, string> = {};
for (const [name, d] of tables)
  for (const [ix, fields] of Object.entries(d.indexes)) indexes[`${name}.${fields[0]}`] = ix;
const engine = await new Engine(
  defineSchema(Object.fromEntries(tables)),
  await MemoryPersistence.open(null, { durable: false }),
).init();

let failAccountCreate = false;
const auth = betterAuth({
  baseURL: "http://localhost:3210",
  secret: "spike-secret-spike-secret-spike-secret-0123",
  database: bunvexAdapter(engine, indexes) as never,
  emailAndPassword: { enabled: true },
  emailVerification: {
    sendOnSignUp: true,
    // In the same transaction: an outbox row, delivered by an action after commit (STUDY-28 §3.3.4).
    sendVerificationEmail: async ({ user, url }) => {
      await currentTx.getStore()!.tx.insert("outbox", { to: user.email, url });
    },
  },
  session: { deferSessionRefresh: true },
  rateLimit: { enabled: false },
  databaseHooks: {
    account: {
      create: {
        before: async () => {
          if (failAccountCreate) throw new Error("injected failure after the user was created");
        },
      },
    },
  },
  plugins: [admin(), jwt({ jwks: { keyPairConfig: { alg: "ES256" } } })],
  logger: { disabled: true },
});
const api = auth.api as unknown as Record<string, (ctx: object) => Promise<{ headers: Headers; response: unknown }>>;

/** The dispatcher: one endpoint, one execution. */
async function call(kind: "mutation" | "query", endpoint: string, ctx: object) {
  const run = () => api[endpoint]({ ...ctx, returnHeaders: true });
  const r =
    kind === "mutation"
      ? await engine.mutation((tx) => currentTx.run({ tx, write: true }, () => withRealCrypto(run)))
      : await engine.query((tx) => currentTx.run({ tx, write: false }, run));
  return { response: r.response as Record<string, unknown> | null, headers: r.headers };
}
const cookieOf = (h: Headers) =>
  h
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const count = async (table: string) =>
  engine.query(async (tx) => (await tx.query(table).fullTableScan().collect()).length);
const ms = async <T>(f: () => Promise<T>) => {
  const t0 = performance.now();
  const r = await f();
  return [r, performance.now() - t0] as const;
};
const report: string[] = [];
const log = (s: string) => {
  report.push(s);
  console.log(s);
};
const attempt = async (name: string, f: () => Promise<void>) => {
  try {
    await f();
  } catch (e) {
    log(`✗ ${name}: ${(e as Error).message}`);
    if (process.env.STACK) console.log((e as Error).stack?.split("\n").slice(1, 12).join("\n"));
  }
};

// 0. Without the real-crypto exception (B5): what breaks.
await attempt("sign-up WITHOUT real crypto", async () => {
  const r = await engine.mutation((tx) =>
    currentTx.run({ tx, write: true }, () =>
      api.signUpEmail({ body: { email: "no@x.dev", password: "password-123", name: "No" }, returnHeaders: true }),
    ),
  );
  log(`! sign-up without real crypto succeeded unexpectedly: ${JSON.stringify(r.response).slice(0, 80)}`);
});

// 1. Sign-up in one mutation.
await attempt("sign-up", async () => {
  const [r, dt] = await ms(() =>
    call("mutation", "signUpEmail", { body: { email: "ada@x.dev", password: "password-123", name: "Ada" } }),
  );
  log(`✓ sign-up in one mutation: ${dt.toFixed(1)} ms; user ${(r.response as { user: { id: string } }).user.id}`);
  log(
    `  rows: user ${await count("user")}, account ${await count("account")}, session ${await count("session")}, outbox ${await count("outbox")}`,
  );
});

// 2. Sign-in, then getSession in a QUERY (read-only).
let cookie = "";
await attempt("sign-in", async () => {
  const [r, dt] = await ms(() =>
    call("mutation", "signInEmail", { body: { email: "ada@x.dev", password: "password-123" } }),
  );
  cookie = cookieOf(r.headers);
  log(
    `✓ sign-in in one mutation: ${dt.toFixed(1)} ms; set-cookie names: ${r.headers
      .getSetCookie()
      .map((c) => c.split("=")[0])
      .join(", ")}`,
  );
});
if (!process.env.LAZY_KEYS)
  await attempt("keys at startup", async () => {
    // The deployment creates its signing key once, in a mutation, instead of the jwt plugin doing it on a read.
    await call("mutation", "getToken", { headers: new Headers({ cookie }) });
    log(`✓ signing key created at startup (a mutation); jwks rows ${await count("jwks")}`);
  });
await attempt("getSession in a query", async () => {
  const headers = new Headers({ cookie });
  const [r, dt] = await ms(() => call("query", "getSession", { headers }));
  log(
    `✓ getSession in a query: ${dt.toFixed(1)} ms; user ${(r.response as { user: { email: string } } | null)?.user.email}`,
  );
  const times: number[] = [];
  for (let i = 0; i < 200; i++) times.push((await ms(() => call("query", "getSession", { headers })))[1]);
  times.sort((a, b) => a - b);
  log(`  getSession ×200: p50 ${times[100].toFixed(2)} ms, p99 ${times[198].toFixed(2)} ms`);
});

// 3. Atomicity: a failure after the user row was written leaves nothing.
await attempt("atomicity", async () => {
  failAccountCreate = true;
  const before = await count("user");
  const r = await call("mutation", "signUpEmail", {
    body: { email: "bob@x.dev", password: "password-123", name: "Bob" },
  }).then(
    () => "succeeded",
    (e) => `failed (${(e as Error).message})`,
  );
  failAccountCreate = false;
  log(
    `✓ sign-up with a failure between user and account: ${r}; users before ${before}, after ${await count("user")}; outbox ${await count("outbox")}`,
  );
});

// 4. Concurrency: 20 distinct sign-ups at once, and 10 sign-ups of ONE email at once.
await attempt("concurrency", async () => {
  const retries0 = engine.stats.retries;
  const [res, dt] = await ms(() =>
    Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        call("mutation", "signUpEmail", { body: { email: `u${i}@x.dev`, password: "password-123", name: `U${i}` } }),
      ),
    ),
  );
  log(
    `✓ 20 concurrent distinct sign-ups: ${res.filter((r) => r.status === "fulfilled").length} ok in ${dt.toFixed(0)} ms, OCC retries ${engine.stats.retries - retries0}`,
  );
  const r1 = engine.stats.retries;
  const same = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      call("mutation", "signUpEmail", { body: { email: "same@x.dev", password: "password-123", name: "Same" } }),
    ),
  );
  const users = await engine.query(
    async (tx) =>
      (
        await tx
          .query("user")
          .withIndex(indexes["user.email"], (b) => b.eq("email", "same@x.dev"))
          .collect()
      ).length,
  );
  const errs = [
    ...new Set(
      same.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r)),
    ),
  ];
  log(
    `✓ 10 concurrent sign-ups of one email: ${same.filter((r) => r.status === "fulfilled").length} ok, users with that email ${users}, OCC retries ${engine.stats.retries - r1}; errors: ${errs.join(" | ").slice(0, 160)}`,
  );
});

// 5. Admin plugin: make Ada admin, list users in a query, ban a user, then their session is gone.
await attempt("admin", async () => {
  await engine.mutation(async (tx) => {
    const ada = await tx
      .query("user")
      .withIndex(indexes["user.email"], (b) => b.eq("email", "ada@x.dev"))
      .first();
    await tx.patch("user", ada!._id as string, { role: "admin" });
  });
  const headers = new Headers({ cookie });
  const [list, dt] = await ms(() =>
    call("query", "listUsers", {
      headers,
      query: { searchValue: "u1", searchField: "email", searchOperator: "contains", limit: 5 },
    }),
  );
  const users = (list.response as { users: { email: string; id: string }[]; total: number }).users;
  log(
    `✓ admin listUsers (search "u1") in a query: ${dt.toFixed(1)} ms; total ${(list.response as { total: number }).total}: ${users.map((u) => u.email).join(", ")}`,
  );
  const victim = users[0];
  const s = await call("mutation", "signInEmail", { body: { email: victim.email, password: "password-123" } });
  const victimCookie = cookieOf(s.headers);
  await call("mutation", "banUser", { headers, body: { userId: victim.id, banReason: "spam" } });
  const after = await call("query", "getSession", { headers: new Headers({ cookie: victimCookie }) });
  log(`✓ banUser in a mutation; the banned user's getSession now: ${after.response === null ? "null" : "STILL VALID"}`);
  const again = await call("mutation", "signInEmail", { body: { email: victim.email, password: "password-123" } }).then(
    () => "signed in (!)",
    (e) => `refused: ${(e as Error).message}`,
  );
  log(`  sign-in after ban: ${again}`);
});

// 6. JWT plugin: a token for the session (keys created lazily on first use).
await attempt("jwt in a mutation", async () => {
  const headers = new Headers({ cookie });
  const [r, dt] = await ms(() => call("mutation", "getToken", { headers }));
  const token = (r.response as { token: string }).token;
  const [h, p] = token
    .split(".")
    .slice(0, 2)
    .map((x) => JSON.parse(Buffer.from(x, "base64url").toString()));
  log(
    `✓ getToken in a mutation: ${dt.toFixed(1)} ms; alg ${h.alg}, sub ${p.sub}, iss ${p.iss}, exp−iat ${p.exp - p.iat}s; jwks rows ${await count("jwks")}`,
  );
});
await attempt("jwt in a query (keys exist now)", async () => {
  const r = await call("query", "getToken", { headers: new Headers({ cookie }) });
  log(`✓ getToken in a query once keys exist: ${(r.response as { token?: string })?.token ? "ok" : "no token"}`);
});

// 7. The action path (OAuth callbacks will run here): an endpoint OUTSIDE any execution. Each adapter call is
// its own transaction, but better-auth's transaction(cb) becomes ONE engine mutation.
await attempt("action path", async () => {
  const calls0 = adapterStats.outsideCalls;
  const [r, dt] = await ms(() =>
    api.signUpEmail({ body: { email: "act@x.dev", password: "password-123", name: "Act" }, returnHeaders: true }),
  );
  log(
    `✓ sign-up from an action: ${dt.toFixed(1)} ms; ${(r.response as { user?: { id: string } }).user ? "user created" : "?"}; adapter calls outside an execution: ${adapterStats.outsideCalls - calls0}`,
  );
  failAccountCreate = true;
  const before = await count("user");
  const f = await api.signUpEmail({ body: { email: "act2@x.dev", password: "password-123", name: "Act2" } }).then(
    () => "succeeded",
    () => "failed",
  );
  failAccountCreate = false;
  log(
    `✓ action sign-up with an injected failure: ${f}; users before ${before}, after ${await count("user")} (atomic through transaction())`,
  );
});

// 8. Is getSession deterministic as a query result? (The jwt plugin's after-hook signs a token on it.)
await attempt("getSession determinism", async () => {
  const headers = new Headers({ cookie });
  const a = await call("query", "getSession", { headers });
  const b = await call("query", "getSession", { headers });
  log(
    `  getSession headers: ${[...a.headers.keys()].join(", ") || "(none)"}; same response twice: ${JSON.stringify(a.response) === JSON.stringify(b.response)}; same set-auth-jwt twice: ${a.headers.get("set-auth-jwt") === b.headers.get("set-auth-jwt")}`,
  );
});

log(
  `adapter: ${adapterStats.calls} calls, ${adapterStats.outsideCalls} outside an execution, ${adapterStats.transactions} transaction() calls`,
);
await Bun.write(`${import.meta.dir}/RESULTS.txt`, `${report.join("\n")}\n`);
await engine.close();
