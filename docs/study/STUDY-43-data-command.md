# STUDY-43 — `bunvex data` (print tables and documents)

- **Status:** accepted: D1 as recommended (owner, 2026-10-02)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-37](STUDY-37-cli-and-environment-variables.md) (the CLI), [STUDY-42](STUDY-42-import-export.md)
  (its sibling commands), [platform §CLI](../parity/platform.md).

## 1. How Convex does it

`npx convex data [table] [--limit n] [--order asc|desc] [--format …] [--component path]`
(`npm-packages/convex/src/cli/data.ts`, `cli/lib/data.ts`, options in `cli/lib/command.ts` `addDataOptions`).

**Without a table** — the tables:
- `_system/cli/tables` (ViewData; `npm-packages/system-udfs/convex/_system/cli/tables.ts`) returns every
  table of the table mapping whose name does not start with `_`, as one page `{ page: [{name}], isDone:
  true, continueCursor: "end" }`.
- The CLI sorts the names and prints one per line on stdout, or on stderr "There are no tables in the
  `<deployment>` deployment's database." (the name only for a cloud deployment; self-hosted: "There are
  no tables in the database.").

**With a table** — its documents:
- `_system/cli/tableData` (ViewData) `{ table, order, paginationOpts }`: `db.query(table)` — `db.system`
  for a `_` name, so `_storage` and `_scheduled_functions` work — `.order(order).paginate({…,
  maximumRowsRead, maximumBytesRead})`.
- The CLI asks for `limit + 1` documents (`runSystemPaginatedQuery`, page after page), so it knows when
  there are more.
- None: "There are no documents in this table." on stderr.
- Each value printed by the CLI's own `stringify`: `null`, a bigint as `5n`, a number by `toString()`, a
  boolean, a string as JSON, bytes as `Bytes("<base64>")`, an array as `[a, b]`, an object as
  `{ "k": v, … }`.
- Formats:
  - `pretty` (the default): a table — the columns `_id`, `_creationTime`, then the other fields sorted,
    each padded to its widest cell, separated by ` | `, under a line of dashes joined by `-|-`; a missing
    field is blank. On a terminal each line is cut at its width minus 10, and then a warning: "Lines were
    truncated to fit the terminal width. Pipe the command to see the full output, such as:\n  `npx
    convex data tableName | less -S`". With more documents than the limit, a warning: "Showing the
    `<n>` most recently created documents. Use the --limit option to see more." (`oldest` for `asc`,
    "document" for 1).
  - `json` / `jsonArray`: `[`, the documents (each by `stringify`) joined by `,\n`, `]`.
  - `jsonl` / `jsonLines`: one `stringify`d document per line. Both use `stringify`, not JSON: a bigint
    prints `5n`.
- `--limit`: a positive integer, default 100. `--order`: default `desc`.

## 2. What an app can observe

The output of the command, byte for byte; that `_storage` and `_scheduled_functions` can be listed; the
two system queries and their operation (ViewData).

## 3. How bunvex does it

- `_system/cli/tables` and `_system/cli/tableData` in `system-functions.ts`, as Convex's: the active user
  tables from `_tables`; the documents through `db` or `db.system`.
- `bunvex data` in `packages/cli/src/data.ts`, with Convex's flags, output and messages ("`bunvex data`"
  in the truncation hint). The terminal width comes from `Io.columns`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | `--component` is refused ("bunvex does not have components yet") | bunvex has no components (Phase 4; as DV-215) | accepted until components (owner, 2026-10-02); DV-224, waiting on components |

## 5. Tests

- The system queries: user tables only, sorted by the CLI; documents in both orders; `_storage`; pages.
- The CLI: every format, byte for byte; the table's columns, padding and missing fields; the `--limit`
  warning (plural, `oldest`); the empty messages; truncation on a narrow terminal and its warning;
  `--limit` and `--order` validation.
