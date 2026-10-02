// The contract suite's part for the app's users (UI-01 §25, data-source-auth-admin.ts): each check runs when
// the source offers the methods it needs; writes only where the credential may write.
import { expect } from "bun:test";
import { type AuthUser, type AuthUserStatus, type DashboardDataSource, userStatus } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
};

async function allUsers(
  src: DashboardDataSource,
  q: { search?: string; provider?: string; status?: AuthUserStatus } = {},
) {
  const out: AuthUser[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const p = await src.listAuthUsers!({ ...q, numItems: 7, cursor });
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
  throw new Error("listAuthUsers never finished");
}

const canWrite = async (src: DashboardDataSource) => {
  const caps = await src.getCapabilities();
  return !caps.readOnly && caps.operations.includes("writeData");
};

export function describeAuthAdminContract({ make, test }: Ctx) {
  test("auth users (when offered): newest first, paged, searched and filtered by provider and status", async () => {
    const src = await make();
    if (!src.listAuthUsers) return;
    if (!(await src.getCapabilities()).operations.includes("viewData")) return;
    const all = await allUsers(src);
    for (let i = 1; i < all.length; i++) expect(all[i]!.createdAt).toBeLessThanOrEqual(all[i - 1]!.createdAt);
    expect(new Set(all.map((u) => u.id)).size).toBe(all.length);
    const first = all[0];
    if (!first) return;
    const word = first.email.slice(0, 5).toUpperCase();
    expect((await allUsers(src, { search: word })).map((u) => u.id)).toEqual(
      all.filter((u) => u.email.toUpperCase().includes(word) || u.name.toUpperCase().includes(word)).map((u) => u.id),
    );
    const provider = first.providers[0];
    if (provider)
      expect((await allUsers(src, { provider })).map((u) => u.id)).toEqual(
        all.filter((u) => u.providers.includes(provider)).map((u) => u.id),
      );
    for (const status of ["verified", "unverified", "banned"] as const)
      expect((await allUsers(src, { status })).map((u) => u.id)).toEqual(
        all.filter((u) => userStatus(u) === status).map((u) => u.id),
      );
    if (src.getAuthUser) {
      expect(await src.getAuthUser(first.id)).toEqual(first);
      expect(await src.getAuthUser("no-such-user")).toBeNull();
    }
  });

  test("auth users (when offered and writable): create, ban signs out, unban, revoke, remove", async () => {
    const src = await make();
    if (!src.listAuthUsers || !src.createAuthUser || !(await canWrite(src))) return;
    const id = await src.createAuthUser({
      name: "Contract",
      email: "contract-user@example.com",
      password: "x".repeat(12),
    });
    expect((await src.listAuthUsers({ numItems: 1, cursor: null })).page[0]!.id).toBe(id);
    await expect(src.createAuthUser({ name: "Again", email: "contract-user@example.com" })).rejects.toThrow();
    if (src.impersonateAuthUser && src.listAuthSessions) {
      const session = await src.impersonateAuthUser(id);
      const mine = await src.listAuthSessions({ userId: id });
      expect(mine.find((s) => s.id === session)?.impersonatedBy).not.toBeNull();
    }
    if (src.banAuthUser && src.getAuthUser) {
      await src.banAuthUser(id, { reason: "test", expiresInSeconds: 60 });
      const banned = (await src.getAuthUser(id))!;
      expect([banned.banned, banned.banReason, banned.banExpires !== null]).toEqual([true, "test", true]);
      if (src.listAuthSessions) expect(await src.listAuthSessions({ userId: id })).toEqual([]);
      await src.unbanAuthUser?.(id);
      if (src.unbanAuthUser) expect((await src.getAuthUser(id))!.banned).toBe(false);
    }
    if (src.removeAuthUser && src.getAuthUser) {
      await src.removeAuthUser(id);
      expect(await src.getAuthUser(id)).toBeNull();
    }
  });

  test("auth config (when offered): read whole, a page merged in, the rest kept", async () => {
    const src = await make();
    if (!src.getAuthConfig) return;
    if (!(await src.getCapabilities()).operations.includes("viewData")) return;
    const config = await src.getAuthConfig();
    expect(Object.keys(config).sort()).toEqual(
      ["emails", "multiFactor", "passkeys", "providers", "rateLimits", "sessions", "urls"].sort(),
    );
    if (!src.updateAuthConfig || !(await canWrite(src))) return;
    const rateLimits = { ...config.rateLimits, max: config.rateLimits.max + 1 };
    const next = await src.updateAuthConfig({ rateLimits });
    expect(next).toEqual({ ...config, rateLimits });
    expect(await src.getAuthConfig()).toEqual(next);
  });
}
