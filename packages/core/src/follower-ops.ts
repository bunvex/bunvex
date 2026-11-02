// The ops an execution worker's engine asks the main thread (STUDY-194 §4.11, 2b step iv): a table's count at a
// snapshot, which the main thread's table summaries hold (pinned at dispatch), and a text search, whose index the
// main thread holds. As text, beside the call's own messages:
//
//   `n<tablet>:<ts>`   a count, answered as its digits
//   `s<json>`          a search: `{tablet, name, q, ts}`, answered as `{hits, indexedBytes}`
//
// A failure the transaction treats as the system's (it fails the run whatever the function catches) is answered as
// itself, so the worker throws the same class: `!u` the summaries still being built, `!r<ts>:<minTs>` a snapshot past
// retention. Any other failure fails the op.
import type { TextHit, TextQuery } from "@bunvex/search";
import { OutOfRetentionError } from "./committer.ts";
import type { FollowerOps } from "./engine.ts";
import type { TabletId } from "./persistence/index.ts";
import type { SearchIndexes } from "./search-indexes.ts";
import { type TableSummaries, TableSummariesUnavailableError } from "./table-summaries.ts";

/** An answer, or the failure it names made again. */
function answered(text: string): string {
  if (text[0] !== "!") return text;
  if (text === "!u") throw new TableSummariesUnavailableError();
  const colon = text.indexOf(":");
  throw new OutOfRetentionError(BigInt(text.slice(2, colon)), BigInt(text.slice(colon + 1)));
}

/** A worker's ops, over `ask` (the worker's way to the main thread). */
export function followerOpsOver(ask: (text: string) => Promise<string>): FollowerOps {
  return {
    count: async (tablet, ts) => Number(answered(await ask(`n${tablet}:${ts}`))),
    search: async (e, q, ts) =>
      JSON.parse(answered(await ask(`s${JSON.stringify({ tablet: e.tablet, name: e.name, q, ts: ts.toString() })}`))),
  };
}

/** The main thread's answer to a worker's op. */
export function answerFollowerOp(text: string, summaries: TableSummaries, search: SearchIndexes): string {
  try {
    return answer(text, summaries, search);
  } catch (e) {
    if (e instanceof TableSummariesUnavailableError) return "!u";
    if (e instanceof OutOfRetentionError) return `!r${e.ts}:${e.minTs}`;
    throw e;
  }
}

function answer(text: string, summaries: TableSummaries, search: SearchIndexes): string {
  if (text[0] === "n") {
    const colon = text.indexOf(":");
    return String(summaries.countAt(text.slice(1, colon) as TabletId, BigInt(text.slice(colon + 1))));
  }
  if (text[0] === "s") {
    const o = JSON.parse(text.slice(1)) as { tablet: TabletId; name: string; q: TextQuery; ts: string };
    const e = search.forTablet(o.tablet).find((x) => x.name === o.name);
    if (!e) throw new Error(`no text index ${o.name} on that table`);
    const hits: TextHit[] = search.search(e, o.q, BigInt(o.ts), new Map());
    return JSON.stringify({ hits, indexedBytes: e.index.indexedBytes });
  }
  throw new Error(`an op the main thread does not answer (${JSON.stringify(text.slice(0, 20))})`);
}
