// STUDY-190: the most frequent stacks under one leaf function of a `bun --cpu-prof` profile, to tell callers of a
// native leaf apart (which statement's `get`, which caller's `JSON.parse`).
//   bun bench/offthread/stacks.ts <file.cpuprofile> <leaf function name> [count] [depth]
import { readFileSync } from "node:fs";

type Node = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
  parent?: number;
};
const [file, leafName, count = "8", depth = "9"] = process.argv.slice(2);
if (!file || !leafName)
  throw new Error("usage: bun bench/offthread/stacks.ts <file.cpuprofile> <leaf> [count] [depth]");
const p = JSON.parse(readFileSync(file, "utf8")) as { nodes: Node[]; samples: number[] };
const byId = new Map<number, Node>();
for (const n of p.nodes) byId.set(n.id, n);
for (const n of p.nodes) for (const c of n.children ?? []) byId.get(c)!.parent = n.id;
const counts = new Map<string, number>();
let all = 0;
for (const s of p.samples) {
  const leaf = byId.get(s)!;
  if (leaf.callFrame.functionName !== leafName) continue;
  all++;
  const stack: string[] = [];
  for (
    let n: Node | undefined = leaf;
    n && stack.length < Number(depth);
    n = n.parent === undefined ? undefined : byId.get(n.parent)
  )
    stack.push(
      `${n.callFrame.functionName || "(anonymous)"}@${n.callFrame.url.split("/").pop() || "native"}:${n.callFrame.lineNumber + 1}`,
    );
  const k = stack.join(" < ");
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
console.log(`${all} samples end in ${leafName}`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, Number(count))) console.log(v, k);
