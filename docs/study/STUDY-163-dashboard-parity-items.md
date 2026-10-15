# STUDY-163 — Small dashboard and CLI parity items

- **Status:** approved by the owner (2026-10-15: match Convex); §1–§3 implemented, §4 planned
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend; Convex's CLI as npm's `convex@1.46.0`
- **Related:** STUDY-149 (the dashboard on real data), STUDY-12 (the dashboard), STUDY-146 / DV-477 (the CLI's
  dashboard links), DV-479 (the dashboard contract follows Convex)

The owner approved four small parity items left after STUDY-149, grouped into PRs by code path. Each is a match to
Convex: no divergence question unless a section says so.

## 1. `?var=` on the environment variables page

### How Convex does it

`dashboard-common/src/features/settings/components/DeploymentEnvironmentVariables.tsx` (`useRequestedEnvVars`,
l. 231–250): the page reads `router.query.var` — one name or, repeated, several — and makes each a new form row
`{ name, value: "" }` (`initialFormValues`, so it shows as a new, touched row); then it removes `var` from the address
with `history.replaceState`, so a reload does not add it again. The rows go into the same Formik form as a row added
by hand: the usual name checks apply, and a name the deployment already has is "used twice" (its uniqueness check).
The rows stay until a save succeeds (`setInitialValues([])`). The self-hosted dashboard serves this page too
(`dashboard-self-hosted/src/pages/settings/environment-variables.tsx` → `EnvironmentVariablesView`).

Who links it: the CLI, when a push fails because the auth config reads a variable the deployment does not have
(`cli/lib/config.ts` l. 970–985, `handlePushConfigError`): "Go to: `<dashboard>/settings/environment-variables?var=
NAME` to set it up." Without a dashboard (self-hosted), "Go set it in the dashboard or using `npx convex env set`".

### What an app's developer observes

The link the CLI prints names the variable; opening it shows a new row with that name and an empty value, ready to
fill and save; the address no longer has the parameter.

### bunvex, before

The page ignored `?var=`, and `bunvex deploy` / `dev` linked `settings/environment-variables` without it (DV-477's
local dashboard link, STUDY-149 PR 8).

### As built

- `packages/dashboard/src/router.tsx`: the route validates `var` (`validateEnvVarsSearch`: one name or several; a name
  the router read as a number back to text; anything else dropped).
- `packages/dashboard/src/settings/screen.tsx`: once the variables load and the credential is known, each name is a
  new row with an empty value (focused), after the deployment's; the parameter is replaced away at once. A name
  already set shows the page's "is used twice." A credential that cannot write gets no row (bunvex's page shows no
  editor to such a credential; Convex's form shows them disabled — presentation).
- `packages/cli/src/dashboard-links.ts` `envVarPage(name)`, used by `deploy` (and `dev`, which pushes through it):
  `settings/environment-variables?var=<name>`.

### Tests

`dashboard/test/settings.test.tsx`: the validator; one name (the row, its empty value, the address cleaned, saved);
two names, one already set ("used twice"); a credential that cannot write. `cli/test/dashboard-links.test.ts`: the
link names the variable. Chromium (`apps/dashboard/e2e`): the row, the address, and a reload adds nothing.

**Sabotage** (each restored, `git diff` clean): no row added → 2 failing (`settings.test.tsx`); the parameter left in
the address → 1; the CLI's link without `?var=` → 1 (`dashboard-links.test.ts`).

## 2. `tableOfId` for system tables

### How Convex does it

`dashboard-common/src/lib/utils.ts`: `getReferencedTableName(tableMapping, id)` decodes the id's table number and
names it from `getTableMapping`, which lists `_file_storage` and `_scheduled_jobs` beside the user tables;
`documentHref` (used by a cell's reference link, `useIdReferenceLink.ts`, and the object editor's id links,
`useIdDecorations.tsx`) sends a `_scheduled_jobs` id to `schedules/functions` (no job selected: a FIXME) and a
`_file_storage` id to `files?id=<id>`; any other system table is reported as unsupported.

### bunvex, before

`@bunvex/dashboard-source`'s `tableOfId` answered null for a system table (`tables.ts`: a mapping name starting with
`_`), and the mock knew only its user tables, so "Go to reference" on a file's or a scheduled run's id said "No
document has the id …", and the cell menu offered "View" instead.

### As built

- The contract's `tableOfId` names those ids by the mapping's names, `_file_storage` and `_scheduled_jobs` (DV-479: the
  contract follows Convex). The server source returns the mapping's name as it is (`getTableMapping` already lists the
  two); the mock looks the id up among its files and scheduled runs.
- `packages/dashboard/src/database/reference.ts` `referenceTarget`, Convex's `documentHref`: a file's id opens Files
  with the file open (`/files?file=<id>`; Convex's `files?id=`), a scheduled run's the scheduled functions (no run
  selected, as Convex's), a user table's its document; another system table, none. "Go to reference" (the cell menu,
  Ctrl+G) and the palette's "Open document" use it.

### Tests

The contract suite: a file's id is `_file_storage`, a scheduled run's `_scheduled_jobs` (mock, and the live server's
deployment-features run). `sync-e2e/dashboard/server-source-ops.test.ts`: an uploaded file's and a scheduled run's
ids on a live server. `dashboard/test/database-menu.test.tsx`: "Go to reference" on each lands on Files with the file
open and on the scheduled functions; `reference.test.ts`: the targets.

**Sabotage** (each restored, `git diff` clean): the source answering null for system tables again → the live test; `referenceTarget` sending a file to the Database screen → `database-menu.test.tsx` and
`reference.test.ts`; the mock not looking at its files → the contract on the mock.

## 3. Schema checks in the document editors

### How Convex does it

`dashboard-common/src/features/data/lib/useToolPopup.tsx`: the add-documents and edit-document panels get the table's
document type from the active schema (`documentType`) and `shouldSurfaceValidatorErrors = schemaValidation`. The
editor (`elements/ObjectEditor/ObjectEditor.tsx`, `walkAst`) checks what is typed against it as it is typed and marks
each misfit: an error that blocks Save when the schema is enforced, a warning that does not otherwise
(`setErrorMarkers`); `JavascriptDocumentsForm.tsx` then says "Please fix the errors above to continue." The cell
editor does the same with the field's type (`validatorForColumn`, mode `editField`; an emptied required field is
`RequiredPropertyMissing`).

### bunvex, before

The editors checked only that the text is a value; a misfit was refused by the deployment on save (enforced) or
saved without a word (not enforced). bunvex had the check already (`validators.ts` `validateValue`, the function
runner's arguments with located underlines).

### As built

- `packages/dashboard/src/database/schema-check.ts`: the table's declared type from `getSchema` (`tableSchema`,
  Convex's `documentType` lookup), a field's (`fieldSchema`, `validatorForColumn`), each misfit at its place in the
  text (`schemaIssues`, `validateValue` over `parseLiteralLocated`; "Document N: " in a list), an emptied required
  field (`requiredFieldIssue`), and how they show (`issueDisplay`).
- The add-documents panel, the document editor and the cell editor check as you type. Enforced: the first misfit is
  the editor's error (underlined, said below it) and the others are underlined too; Save / Add / Enter do nothing.
  Not enforced: each misfit is underlined as a warning, a note says the schema is not enforced, and saving works.
- `@bunvex/ui`'s `CodeEditor` gained `warnings` (Monaco's warning markers).
- The messages are the runner's (`validateValue`'s), bunvex's wording of Convex's `ConvexSchemaValidationError`
  ("Type 'number' is not assignable to v.string()"; Convex prints the validator on the next line, pretty). Below the
  editor, enforced, bunvex says the first misfit where Convex says "Please fix the errors above to continue.":
  presentation, the markers being the same.
- The mock's `schemaEnforced` option says the schema is enforced (default false, as before).

### Tests

`dashboard/test/editor-schema-checks.test.tsx`: the model (a table's and a field's type, places of a wrong value, an
extra key and a missing field, a list's document number, a cell emptied or `undefined`, the display both ways); add
documents enforced (blocked, then added once it fits) and not (a warning, added); the document editor enforced
(blocked); the cell editor enforced (said as typed, Enter keeps the editor, nothing saved). The existing writes
tests keep passing on the mock (not enforced). In Chromium (`apps/dashboard/e2e`): Monaco's warning underline and the
note, and Add allowed.

**Sabotage** (each restored, `git diff` clean; failing tests in `editor-schema-checks.test.tsx`):

| Sabotage | Failing |
|---|---|
| enforced shown as warnings | 4 |
| an extra key pointed at its value, not its key | 1 |
| the document editor's Save not blocked | 1 |
| the cell editor's Enter saving a misfit | 1 |
| Add not blocked | 1 |

## 4. `dev`'s remaining lines

### What was compared

`npx convex dev` (npm's `convex@1.46.0`, self-hosted against Convex's binary) and `bunvex dev` (against bunvex's), the
same app, with `--once` and without, output captured whole:

| Convex | bunvex |
|---|---|
| `Saved CONVEX_URL and CONVEX_SITE_URL to .env.local` (first run, `configure.ts` l. 495) | nothing |
| `▌ Developing against deployment:` / `▌ └─ <url>` (`announceDeploymentTarget.ts`, a tag line for a local deployment) | `Developing against deployment: <url>` |
| `- Preparing Convex functions...`, a blank line | `Preparing bunvex functions...` |
| `✔ <time> Convex functions ready! (197.06ms)` (`formatDuration`) | `✔ <time> bunvex functions ready! (0.02s)` |

A first local run also prints, on a terminal, Convex's three introductory lines and "Continue?"
(`localDeployment/anonymous.ts` l. 63–90), and after configuring a deployment Convex's `finalizeConfiguration`
(`cli/lib/init.ts`) says what it saved, only when it changed, then where the functions go, where to give feedback and
the dashboard (STUDY-149 PR 8 left these as gaps). "- Preparing …" and the blank line are Convex's spinner on a
stream that is not a terminal, not lines of their own.

### As built

`packages/cli/src/dev.ts` and `local-deployment.ts`, each line in bunvex's words (rule 5):

- **A first local run** (no `.bunvex/local/default/config.json`): "Setting up a new project..." (Convex's
  `chooseDeployment` for a first anonymous deployment), then, on a terminal, Convex's three lines ("This command,
  `bunvex dev`, will run your bunvex backend locally …", "Use `bunvex dashboard` …", "Use `bunvex docs` … `bunvex
  help` …") and "Continue? (Y/n)"; no prints "Exiting" and stops (exit 1), nothing created.
- **The configuration lines**, Convex's `finalizeConfiguration` in place of the old "✔ Started running a deployment
  locally at …" (Convex's older wording): only when `.env.local` or `.gitignore` changed, and only what changed —
  "✔ Configured a local deployment for <url> and saved its:" / "name as BUNVEX_DEPLOYMENT" / "client URL as <name>" /
  "HTTP actions URL as <name>" / " to .env.local" (or "… saved its name as BUNVEX_DEPLOYMENT to .env.local"), then
  `  Added ".env.local" to .gitignore`; then "Write your bunvex functions in <dir>/", "Give us feedback at <url>" and,
  while `dev` serves the local dashboard, "View the bunvex dashboard at <url>" (DV-477: no line without one).
- **A self-hosted `dev`** (`BUNVEX_SELF_HOSTED_*`, `--url` / `--admin-key`), Convex's `handleManuallySetUrlAndAdminKey`:
  `BUNVEX_DEPLOYMENT` removed from `.env.local` ("Removed the BUNVEX_DEPLOYMENT environment variable from .env.local"),
  the deployment's canonical URLs (`/api/v1/get_canonical_urls`) written as the client's variables and said ("Saved
  BUNVEX_URL and BUNVEX_SITE_URL to .env.local"), each only when it changes. A deployment that cannot be reached
  leaves the file alone (the push then says so and retries; Convex's `dev` stops there).
- **The deployment line**, Convex's `announceDeploymentTarget` without colours: "▌ Developing against deployment:",
  for a local deployment "▌ [Local] Port <port>" with "(dashboard: <url>)" (a link on a terminal), and "▌ └─ <url>".
- **Durations** in Convex's `formatDuration` (ns, µs, ms, s, m, two decimals): "✔ 16:02:11 bunvex functions ready!
  (197.06ms)", "Failed due to network error, retrying in 1.2s...".

The feedback line points at bunvex's issues (`https://github.com/bunvex/bunvex/issues`): Convex names its community
and its support address; rule 5 needs bunvex's own (an owner question below).

### Tests

`cli/test/dev.test.ts`: the deployment line (self-hosted, local with and without a dashboard, the terminal's links),
the configuration lines (each combination, none for no change), the closing lines (the functions' directory, the
dashboard only with one), a self-hosted `dev` saving the URLs once, `--url` removing `BUNVEX_DEPLOYMENT`, the ready
line's duration. `cli/test/local-deployment.test.ts`: the first run's lines exactly; on a terminal the introduction,
"Continue?" answered no (exit 1, nothing created) and yes; the next run prints none of them and names the deployment by
its port. `dashboard-serve.test.ts`: the dashboard line inside the closing lines, none offline.

**Sabotage** (each restored, `git diff` clean): the configuration lines printed with nothing changed → 2; the first
run's introduction skipped → 2; the self-hosted URLs not saved → 2; the old deployment line → 3.

