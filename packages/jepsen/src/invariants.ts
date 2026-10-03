// The invariants checked beside linearizability (STUDY-57 §3.5). Each returns the violations it found, as
// sentences that name the operations involved; an empty list is a pass.
import type { Op } from "./history.ts";

/** Bank: every read (one query, one snapshot) sums to the total; the final balances too, none negative. */
export function checkBank(ops: readonly Op[], total: number, final: Record<string, number>): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.f !== "bank:all" || op.status !== "ok") continue;
    const sum = Object.values(op.result as Record<string, number>).reduce((a, b) => a + b, 0);
    if (sum !== total) out.push(`bank: a read at ${op.start.toFixed(1)} ms saw a total of ${sum}, not ${total}`);
  }
  const sum = Object.values(final).reduce((a, b) => a + b, 0);
  if (sum !== total) out.push(`bank: the final balances total ${sum}, not ${total}`);
  for (const [name, b] of Object.entries(final)) if (b < 0) out.push(`bank: account ${name} ended at ${b}, below zero`);
  return out;
}

/**
 * Set: every acknowledged add is in the final set, nothing is there that was never added, and no token is
 * there twice (a mutation that ran twice: the idempotency that resending relies on, STUDY-23).
 */
export function checkSet(ops: readonly Op[], final: readonly string[]): string[] {
  const out: string[] = [];
  const attempted = new Set<string>();
  const acked = new Set<string>();
  const failed = new Set<string>();
  for (const op of ops) {
    if (op.f !== "set:add") continue;
    const token = (op.args as { token: string }).token;
    attempted.add(token);
    if (op.status === "ok") acked.add(token);
    if (op.status === "fail") failed.add(token);
  }
  const counts = new Map<string, number>();
  for (const t of final) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of acked) if (!counts.has(t)) out.push(`set: ${t} was acknowledged but is lost`);
  for (const [t, n] of counts) {
    if (!attempted.has(t)) out.push(`set: ${t} is present but was never added`);
    if (failed.has(t)) out.push(`set: ${t} is present, but its add was reported failed`);
    if (n > 1) out.push(`set: ${t} is present ${n} times (a mutation ran more than once)`);
  }
  return out;
}

/**
 * The ops log: each client's appends, in commit order, have increasing sequence numbers (a connection's
 * mutations run one at a time, in the order sent, STUDY-22); none is there twice; every acknowledged one is.
 */
export function checkLog(ops: readonly Op[], final: readonly (readonly [number, number])[]): string[] {
  const out: string[] = [];
  const last = new Map<number, number>();
  const seen = new Set<string>();
  for (const [client, seq] of final) {
    const k = `${client}/${seq}`;
    if (seen.has(k)) out.push(`log: client ${client}'s mutation ${seq} committed twice`);
    seen.add(k);
    const prev = last.get(client) ?? -1;
    if (seq < prev) out.push(`log: client ${client}'s mutation ${seq} committed after its mutation ${prev}`);
    last.set(client, Math.max(prev, seq));
  }
  for (const op of ops) {
    if (op.f !== "log:append" || op.status === "info") continue;
    const { client, seq } = op.args as { client: number; seq: number };
    const present = seen.has(`${client}/${seq}`);
    if (op.status === "ok" && !present)
      out.push(`log: client ${client}'s mutation ${seq} was acknowledged but is lost`);
    if (op.status === "fail" && present)
      out.push(`log: client ${client}'s mutation ${seq} is present, but it was reported failed`);
  }
  return out;
}
