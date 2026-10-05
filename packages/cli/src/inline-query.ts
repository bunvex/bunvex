// A one-off readonly query (STUDY-119), as Convex's cli/lib/runTestFunction.ts: the text `bunvex run
// --inline-query` takes made into a module whose default export is a query, sent to the deployment's
// function tester (`POST /api/run_test_function`). The MCP server's `runOneoffQuery` sends modules the same way.
import type { Target } from "./target.ts";

/** Where the function tester's `query` and `internalQuery` come from (DV-390). */
export const REPL_WRAPPERS = "bunvex:/_system/repl/wrappers.js";
const PREAMBLE = `import { query, internalQuery } from "${REPL_WRAPPERS}";`;

export const INLINE_QUERY_HELP = `JavaScript run as a readonly query: it can read data, not write it or reach the network.
                         One-shot: not with --watch. Its form:
                         • an expression is returned: \`await ctx.db.query("messages").take(5)\`
                         • statements return explicitly: \`const m = await ctx.db.query("messages").first(); return m;\`
                         • a module whose default export is a query, as is:
                           \`export default query({ handler: async (ctx) => ctx.db.query("messages").take(10) })\``;

/** Statements start with one of these words; anything else on one line is an expression. */
const STATEMENT = /^(const|let|var|if|for|while|switch|try|throw|return)\b/;

/**
 * The module for an inline query, by Convex's rules: text with `export default` and a call of `query(` or
 * `internalQuery(` is a module already (the wrappers' import added unless it is there); a single line that
 * does not start a statement is an expression, returned; anything else is the handler's body as written.
 */
export function inlineQuerySource(inlineQuery: string): string {
  const text = inlineQuery.trim();
  if (text.includes("export default") && /\b(?:query|internalQuery)\s*\(/.test(text))
    return text.includes(REPL_WRAPPERS) ? text : `${PREAMBLE}\n\n${text}`;
  const body = !text.includes("\n") && !STATEMENT.test(text) ? `return (${text.replace(/;$/, "")});` : text;
  const indented = body
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  return `${PREAMBLE}\n\nexport default query({\n  handler: async (ctx) => {\n${indented}\n  },\n});`;
}

/** The function tester's answer: the value and log lines, or the run's failure (its whole response). */
export type TestQueryResult =
  | { kind: "success"; value: unknown; logLines: string[] }
  | { kind: "failure"; payload: unknown };

/** The request failed before the query ran (a refused module or key): Convex's fetch error, as it prints it. */
export class TestQueryRequestError extends Error {}

/** Run `source` (a module whose default export is a query) on the deployment, once. */
export async function runTestQuery(target: Target, source: string): Promise<TestQueryResult> {
  const url = `${target.url}/api/run_test_function`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${target.adminKey}` },
      body: JSON.stringify({
        adminKey: target.adminKey,
        args: {},
        bundle: { path: "testQuery.js", source },
        format: "encoded_json",
      }),
    });
  } catch (e) {
    throw new TestQueryRequestError(`could not reach ${target.url}: ${(e as Error).message}`);
  }
  if (!r.ok) {
    // Convex's `ThrowingFetchError`: `Error fetching POST  <url> <status> <text>: <code>: <message>`; a 403
    // is its message alone, a 404 adds the URL.
    let code: unknown;
    let message: unknown;
    try {
      ({ code, message } = (await r.json()) as { code?: unknown; message?: unknown });
    } catch {}
    const head = `Error fetching POST  ${url} ${r.status} ${r.statusText}`;
    const full = code !== undefined && message !== undefined ? `${head}: ${code}: ${message}` : head;
    if (r.status === 403 && message !== undefined) throw new TestQueryRequestError(String(message));
    throw new TestQueryRequestError(r.status === 404 ? `${full}: ${url}` : full);
  }
  const body = (await r.json()) as { status?: unknown; value?: unknown; logLines?: string[] } | null;
  if (body === null || typeof body !== "object" || body.status !== "success") return { kind: "failure", payload: body };
  return { kind: "success", value: body.value, logLines: body.logLines ?? [] };
}
