# STUDY-163 — Small dashboard and CLI parity items

- **Status:** approved by the owner (2026-10-15: match Convex); §1 implemented, §2–§4 planned (one PR each)
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

`@bunvex/dashboard-source`'s `tableOfId` answers null for a system table (`tables.ts`: a mapping name starting with
`_`), so "Go to reference" on a file's or a scheduled run's id says "No document has the id …". To be built: the
contract's `tableOfId` names those two tables, and "Go to reference" (and the palette's "Open document") opens Files
on the file or the scheduled functions list, as Convex's.

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

The editors check only that the text is a value; a misfit is refused by the deployment on save. bunvex has the check
already (`validators.ts` `validateValue`, used by the function runner's arguments with located underlines). To be
built: the same check in the add, edit and cell editors, blocking when enforced, a warning otherwise.

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
(`localDeployment/anonymous.ts` l. 63–90). To be built in its PR, each line in bunvex's words (rule 5); the details
are settled there.
