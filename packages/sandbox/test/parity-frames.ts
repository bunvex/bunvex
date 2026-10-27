// The vm/process parity suites compare error stacks. JavaScriptCore puts the frame that constructed an error at the
// `new` on most runs and at the call's `(` on some, under either executor (deepThrow in CI run 40424020167, a
// component's `app:uncaught` in merge-group run 40595294280 for #926), so that one column is not compared. The line, and every
// frame below it, still are.

// An error's header line (`Uncaught Error: …`, `TypeError: …`), then its first frame's `:line:column`. The line breaks
// may be real or, inside a JSON-encoded log line, escaped (`\n`).
const FIRST_FRAME = /((?:^|\n|\\n)[^\n\\]*Error\b[^\n\\]*(?:\n|\\n)\s*at [^\n\\]*?:\d+:)\d+(\)?)/g;

/** `t` with the column of each error's constructing frame replaced by `<col>`. */
export const constructedAt = (t: string) => t.replace(FIRST_FRAME, "$1<col>$2");
