// A program (STUDY-122 §3.1): calls of the app, its ids written as references (`{ ref: "r1" }`) that each
// backend resolves to its own ids (those of earlier calls: a reference is resolved before its call is sent),
// and a page's cursor named for a later page to continue from. `run` plays it on one backend; `compare` plays
// it on both and returns the differences of the normalised records (each answer, then every table's contents).

import type { Backend } from "./backends.ts";
import { answerShape, creationTimes, IdMap, normalize, type Step } from "./compare.ts";

export type Ref = { ref: string };
export type ProgramOp =
  | { kind: "insert"; table: "a" | "b"; doc: Record<string, unknown>; as: string }
  | { kind: "patch"; id: Ref; fields: Record<string, unknown> }
  | { kind: "replace"; id: Ref; doc: Record<string, unknown> }
  | { kind: "delete"; id: Ref }
  | { kind: "get"; id: Ref }
  | { kind: "read"; read: Record<string, unknown>; mutateResult?: boolean }
  | { kind: "throw"; message: string }
  | { kind: "undefinedResult" };
export type Call =
  | { kind: "apply"; ops: ProgramOp[] }
  | { kind: "read"; read: Record<string, unknown> }
  /** A page of `read`, from the start (`from` null) or from where the page named `from` ended. */
  | { kind: "page"; read: Record<string, unknown>; numItems: number; from: string | null; as: string };
export type Program = Call[];

type Record_ = { steps: Step[]; dump: unknown; ids: IdMap };

/** Play `program` on `backend`. */
export async function run(backend: Backend, program: Program, opts: { reset?: boolean } = {}): Promise<Record_> {
  // From empty tables, when a backend serves one program after another.
  if (opts.reset) {
    const r = await backend.call("mutation", "ops:reset", {});
    if (!r.ok) throw new Error(`${backend.name}: reset failed: ${JSON.stringify(r.body)}`);
  }
  const refs = new Map<string, string>();
  const cursors = new Map<string, string | null>();
  const ids = new IdMap();
  const resolve = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(resolve);
    if (x && typeof x === "object") {
      if ("ref" in x && Object.keys(x).length === 1) return refs.get((x as Ref).ref) ?? `missing:${(x as Ref).ref}`;
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolve(v)]));
    }
    return x;
  };
  const steps: Step[] = [];
  for (const call of program) {
    if (call.kind === "apply") {
      const ops = call.ops.map((op) => {
        const { as: _, ...rest } = op as ProgramOp & { as?: string };
        return resolve(rest);
      });
      const answer = await backend.call("mutation", "ops:apply", { ops });
      steps.push({ kind: "mutation", path: "ops:apply", args: call.ops, answer });
      const body = answer.body as { status?: string; value?: unknown[] };
      if (answer.ok && body.status === "success")
        call.ops.forEach((op, i) => {
          if (op.kind !== "insert") return;
          const id = body.value![i] as string;
          refs.set(op.as, id);
          ids.add(id, op.table);
        });
    } else if (call.kind === "page") {
      const cursor = call.from === null ? null : (cursors.get(call.from) ?? null);
      const answer = await backend.call("query", "ops:page", {
        read: resolve(call.read),
        numItems: call.numItems,
        cursor,
      });
      steps.push({ kind: "query", path: "ops:page", args: call, answer });
      const body = answer.body as { status?: string; value?: { continueCursor?: string } };
      if (answer.ok && body.status === "success") cursors.set(call.as, body.value?.continueCursor ?? null);
    } else {
      const answer = await backend.call("query", "ops:read", { read: resolve(call.read) });
      steps.push({ kind: "query", path: "ops:read", args: call.read, answer });
    }
  }
  const dump = (await backend.call("query", "ops:dump", {})).body;
  return { steps, dump, ids };
}

/** The differences between the two backends' records of `program`, normalised; empty when they agree. */
export async function compare(
  oracle: Backend,
  bunvex: Backend,
  program: Program,
  opts: { reset?: boolean } = {},
): Promise<string[]> {
  const [a, b] = await Promise.all([run(oracle, program, opts), run(bunvex, program, opts)]);
  const view = (r: Record_) => {
    const times = [...creationTimes([r.steps.map((s) => s.answer.body), r.dump])].sort((x, y) => x - y);
    return {
      steps: r.steps.map((s) => answerShape(s.answer, r.ids, times)),
      dump: normalize(r.dump, r.ids, times),
    };
  };
  const [va, vb] = [view(a), view(b)];
  const diffs: string[] = [];
  va.steps.forEach((s, i) => {
    const x = JSON.stringify(s);
    const y = JSON.stringify(vb.steps[i]);
    if (x !== y) diffs.push(`call ${i} (${JSON.stringify(program[i])}):\n  convex: ${x}\n  bunvex: ${y}`);
  });
  if (JSON.stringify(va.dump) !== JSON.stringify(vb.dump))
    diffs.push(`final data:\n  convex: ${JSON.stringify(va.dump)}\n  bunvex: ${JSON.stringify(vb.dump)}`);
  return diffs;
}
