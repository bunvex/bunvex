# STUDY-101 — The 10 000-table cap

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (push), [STUDY-42](STUDY-42-import-export.md) (import's hidden
  tables), [STUDY-14](STUDY-14-schemas.md)

## 1. How Convex does it

`crates/database/src/bootstrap_model/table.rs` sets `MAX_USER_TABLES = 10000`.
`TableModel::_insert_table_metadata` refuses a new table when both hold:

- its name is not a system name;
- the deployment already has `count_user_tables()` (its active user tables, all namespaces together) ≥ 10 000.

The refusal is `index_validation_error::too_many_tables`: 400 `TooManyTables`,
"Number of tables cannot exceed 10000.".

The check runs inside the transaction that creates the table, on every path that creates one:

- a write to a new table;
- a schema push that declares new tables;
- an import's hidden table (`insert_table_for_import`). It is not checked again when that table is
  activated.

A table that already exists is never refused, and hidden or deleting tables do not count.

## 2. What an app can observe

At 10 000 tables, the following fail with "Number of tables cannot exceed 10000.":

- a mutation that inserts into a new table;
- a push or import that adds a table.

## 3. How bunvex does it

The table allocation in `planCatalog` (`@bunvex/core` `catalog.ts`) is where all three paths create tables:

- `Tx.createTable`, for a write;
- `Engine.startSchemaPush`;
- `Engine.createHiddenTable`, for an import.

`planCatalog` counts the active user tables, adds each new one it plans, and throws `TooManyTablesError`
(`code: "TooManyTables"`, Convex's message) for a new user table past 10 000.

The hidden-table path passes the real name's kind. An import's hidden table is planned under a placeholder
name, so for `_storage` it would otherwise count as a user table.

A push maps the error to a 400 `TooManyTables` `PushError` with the bare message. A mutation surfaces it as
its uncaught error.

## 4. Divergences

None. The push answer's text is not compared with a Convex run.

## 5. Tests

`packages/core/test/table-cap.test.ts` covers:

- the 10 000th table created and the 10 001st refused, with Convex's message and code;
- what does not count or is never refused: existing tables, system tables, hidden and deleting tables, a
  system table's hidden import table;
- tables planned together counted as they are added;
- in an engine:
  - a push of 10 001 tables is refused;
  - after a push of 10 000, a write to a new table is refused;
  - a write to an existing one still works.

Sabotage checks:
<!-- filled after the run -->

## 6. Open questions

None.
