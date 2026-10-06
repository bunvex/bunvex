// The stored auth providers (STUDY-129), as Convex's `_auth` (crates/model/src/auth): one document per provider
// of the deployed `auth.config`, written by a push and by the variable and canonical URL changes that
// re-evaluate it, read by token checks and the dashboard (`listAuthProviders`).
import type { AuthInfo } from "@bunvex/auth";
import { AUTH_TABLE, type Tx } from "@bunvex/core";

type AuthDoc = Record<string, string | null>;

/**
 * A provider as Convex's `AuthInfoPersisted`: OIDC `{applicationID, domain}`; a custom JWT
 * `{type: "customJwt", applicationID, issuer, jwks, algorithm}` with `applicationID` null when absent and the
 * algorithm as its JSON string (quotes included, as Convex's `String::from(SignatureAlgorithm)`).
 */
export function authInfoDoc(info: AuthInfo): AuthDoc {
  return info.kind === "oidc"
    ? { applicationID: info.applicationId, domain: info.domain }
    : {
        type: "customJwt",
        applicationID: info.applicationId ?? null,
        issuer: info.issuer,
        jwks: info.jwks,
        algorithm: JSON.stringify(info.algorithm),
      };
}

/** A stored provider back (Convex reads a document without `type` as OIDC). */
export function authInfoOf(doc: Record<string, unknown>): AuthInfo {
  if (doc.type === "customJwt") {
    const info: AuthInfo = {
      kind: "customJwt",
      issuer: doc.issuer as string,
      jwks: doc.jwks as string,
      algorithm: JSON.parse(doc.algorithm as string) as "RS256" | "ES256",
    };
    if (typeof doc.applicationID === "string") info.applicationId = doc.applicationID;
    return info;
  }
  return { kind: "oidc", applicationId: doc.applicationID as string, domain: doc.domain as string };
}

/** A provider's document as Convex's diff prints it (`json_serialize`: its keys in order). */
const docJson = (d: AuthDoc) =>
  JSON.stringify(Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** Convex's `AuthInfo` order (its derived `Ord`): OIDC first, then field by field; an absent id first. */
function compareInfo(a: AuthInfo, b: AuthInfo): number {
  const fields = (i: AuthInfo): (string | null)[] =>
    i.kind === "oidc"
      ? ["0", i.applicationId, i.domain]
      : ["1", i.applicationId ?? null, i.issuer, i.jwks, i.algorithm];
  const x = fields(a);
  const y = fields(b);
  for (let k = 0; k < x.length; k++) {
    if (x[k] === y[k]) continue;
    if (x[k] === null) return -1;
    if (y[k] === null) return 1;
    return x[k]! < y[k]! ? -1 : 1;
  }
  return 0;
}

/** The stored providers, in `_creationTime` order (as Convex's full table scan). */
export async function readAuthInfo(db: Tx): Promise<AuthInfo[]> {
  const rows = (await db.asSystem(() => db.query(AUTH_TABLE).collect())) as Record<string, unknown>[];
  return rows.map(authInfoOf);
}

/**
 * Convex's `AuthInfoModel::put`: store exactly `infos`. A provider already stored keeps its document; the
 * others are deleted and the new ones inserted. The diff, as Convex's `AuthDiff`: each provider's document in
 * JSON.
 */
export async function putAuthInfo(db: Tx, infos: AuthInfo[]): Promise<{ added: string[]; removed: string[] }> {
  const wanted = new Map(infos.map((i) => [docJson(authInfoDoc(i)), i]));
  const removed: AuthInfo[] = [];
  const rows = (await db.asSystem(() => db.query(AUTH_TABLE).collect())) as Record<string, unknown>[];
  for (const row of rows) {
    const info = authInfoOf(row);
    if (wanted.delete(docJson(authInfoDoc(info)))) continue;
    await db.asSystem(() => db.delete(AUTH_TABLE, row._id as string));
    removed.push(info);
  }
  const added = [...wanted.values()].sort(compareInfo);
  for (const info of added) await db.asSystem(() => db.insert(AUTH_TABLE, authInfoDoc(info)));
  const json = (l: AuthInfo[]) => l.sort(compareInfo).map((i) => docJson(authInfoDoc(i)));
  return { added: json(added), removed: json(removed) };
}
