// `getAuthUserId` (STUDY-201 §1.4), v2's: the user a caller is signed in as, through the session its access token
// names (the token's subject), so a revoked session stops resolving at once, before its token expires.
import { type Auth, componentsGeneric, type GenericDataModel, type GenericQueryCtx } from "@bunvex/server";
import type { GenericId } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";

// The core mounted under its default name, `auth`: the app's `components.auth`, so the usual call needs only `ctx`.
const defaultComponent = (componentsGeneric() as unknown as { auth: ComponentApi }).auth;

/**
 * The id of the user the caller is signed in as, or `null` when it is not signed in. Call it with a query's,
 * mutation's or action's `ctx`.
 *
 * ```ts
 * import { getAuthUserId } from "@bunvex/auth/server";
 *
 * export const loggedInUser = query({
 *   args: {},
 *   handler: async (ctx) => {
 *     const userId = await getAuthUserId(ctx);
 *     return userId === null ? null : await ctx.db.get(userId);
 *   },
 * });
 * ```
 *
 * The access token names a session, not a user: this looks the session up (one call to the component) and returns
 * `null` once it is gone (signed out, revoked, expired), even while the token is still valid; a subscribed query re-runs
 * when the session goes. The id is typed as one of the `users` table, or of the table you name
 * (`getAuthUserId<"members">(ctx)`). With the core mounted under another name, pass it: `getAuthUserId(ctx,
 * components.myAuth)`.
 */
export async function getAuthUserId<UsersTable extends string = "users">(
  ctx: { auth: Auth; runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] },
  component: ComponentApi = defaultComponent,
): Promise<GenericId<UsersTable> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  const session = await ctx.runQuery(component.public.getSession, { sessionId: identity.subject });
  return session === null ? null : (session.userId as GenericId<UsersTable>);
}
