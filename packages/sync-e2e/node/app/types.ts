// Typechecked by `tsc` (../npm-packages.node.ts) in the app's directory: the packages' published declarations,
// read without `allowImportingTsExtensions` (they are `.d.ts`, not the sources).
import { BunvexHttpClient } from "@bunvex/client";
import { makeFunctionReference } from "@bunvex/server";
import { type Infer, v } from "@bunvex/values";

const ref = makeFunctionReference<"query", { n: number }, number>("m:q");
const http = new BunvexHttpClient("http://127.0.0.1:1");
export const ok: Promise<number> = http.query(ref, { n: 1 });
// @ts-expect-error: the arguments' type comes from the declarations (an `any` would accept it)
export const bad = http.query(ref, { n: "1" });

const object = v.object({ body: v.string() }).extend({ n: v.number() });
export const doc: Infer<typeof object> = { body: "x", n: 1 };
// @ts-expect-error: as does the validator's
export const wrong: Infer<typeof object> = { body: 1, n: 1 };
