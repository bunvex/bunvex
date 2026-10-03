# STUDY-56 — The checks before a push (`evaluate_schema`, large indexes)

- **Status:** P1 accepted as recommended (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03
- **Related:** [STUDY-35](STUDY-35-push.md) (pushes), [STUDY-29](STUDY-29-index-backfill.md) (staged indexes),
  [STUDY-52](STUDY-52-shape-inference.md) (table summaries: the counts this needs)

## 1. How Convex does it

### 1.1 `POST /api/deploy2/evaluate_schema`

`local_backend/src/deploy_config2.rs`; `application/src/deploy_config.rs` `evaluate_schema_prediction`.

- The request is `start_push`'s body. Only the schema bundles are evaluated (an error is `InvalidSchema`); no function module is analyzed. The `Deploy` operation is required.
- Nothing is changed. It needs the table counts: while they bootstrap, the answer is 503 `TableSummariesUnavailable` ("Table summary unavailable (still bootstrapping)").
- The answer is `{componentSchemaEvaluations: {<componentPath>: {definitionPath, schemaValidation, tables, indexes}}, newComponentDefinitions}`.
  - **`indexes`**: each index of the diff between the stored indexes and the pushed schema (`get_index_diff`), as `{name, type, …spec, staged, change, needsBackfill, numDocs}`.
    - `change` is `added`, `identical`, `enabled`, `disabled` or `dropped`. A changed definition is dropped and added.
    - `needsBackfill` is true for an added index, and for an identical or enabled one still backfilling.
    - `numDocs` is the table's count.
    - A definition with no schema drops every index.
  - **`tables`**: each declared table's outcome, with `numDocs` and `sizeBytes`:
    - `notValidated`: schema validation is off;
    - `supersetOfEnforced`: the new validator is a superset of the enforced one;
    - `supersetOfShape`: the new validator is a superset of the table's inferred shape;
    - `mustWalk`: otherwise.

### 1.2 The CLI (`cli/lib/components.ts` `runPush`)

- **Before `start_push`**: one shared `evaluate_schema` call, skipped against a deployment without the route.
- **`checkForLargeIndexDeletion`**, when deleting:
  - It lists the dropped indexes, with "→ replaced by" when the same name is added.
  - If any is on a table of 100 000 documents or more (`CONVEX_MIN_DOCUMENTS_FOR_INDEX_DELETE_WARNING`), it warns "This code push will delete the following index…".
  - Then it asks "Delete this index?", default no. Without a terminal the push stops with "To confirm the push: • run the deploy command in an interactive terminal • or … --skip-large-indexes-check flag".
  - A flag proceeds: "Proceeding with push since deleting large indexes was allowed by flag".
  - With nothing to report it says "No indexes are deleted by this push" or "No large indexes are deleted by this push".
- **`checkForLargeIndexBackfill`**:
  - It concerns non-staged indexes that are added, or enabled before their backfill finished, on tables of 100 000 documents or more (`CONVEX_MIN_DOCUMENTS_FOR_INDEX_BACKFILL_WARNING`).
  - It warns "This push will create the following index on a large table … The deploy will block until it finishes backfilling", with the staging tip.
  - It asks "Create this index now?".
  - `--skip-large-indexes-check` proceeds. A dry run only warns.
- **`checkForSlowSchemaValidation`** (dry runs): the `mustWalk` tables, when they total 128 MiB or more (`CONVEX_MIN_BYTES_FOR_SCHEMA_WALK_WARNING`).
- **Which commands check**:
  - `deploy` checks both, with `--skip-large-indexes-check` and the hidden `--allow-deleting-large-indexes` (deletion only).
  - `dev` checks neither against a non-production deployment.
- **`--message`** defaults to the CI platform and commit (`getDefaultDeployMessage`: GitHub Actions, Vercel, Netlify, …), e.g. "Deployed from GitHub Actions • 0123456".

## 2. What an app can observe

The CLI's prompts, messages and exit codes before a push; the `evaluate_schema` answer.

## 3. How bunvex does it

- **`Engine.evaluateSchema`** (core) computes the prediction:
  - stored `_index` rows (their `_creationTime` suffix aside) against the pushed indexes;
  - the active schema's search and vector indexes against the pushed ones, with their readiness;
  - counts and sizes from the table summaries (STUDY-52 PR 2).
- **`POST /api/deploy2/evaluate_schema`** evaluates the schema only, and answers Convex's shape for the root component.
- **`packages/cli/src/index-checks.ts`** holds the three checks and Convex's messages:
  - the thresholds' environment variables are named `BUNVEX_…` (rule 5);
  - Convex's documentation link is left out (rule 5).
- **`bunvex deploy`** runs them, with `--skip-large-indexes-check`, the hidden `--allow-deleting-large-indexes`, and the default `--message`. `bunvex dev` does not.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| P1 | A table's outcome is `supersetOfEnforced` only when its validator is unchanged, else `mustWalk`; never `supersetOfShape` | It is what bunvex's schema walk does (STUDY-35: it walks tables whose validator changed). Convex skips more: a new validator that is a superset of the old one, or of the inferred shape. **Not done yet**: needs validator subtyping and shape-to-validator, then the walk can skip the same tables | DV-301, accepted (owner, 2026-10-03) |
