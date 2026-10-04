# STUDY-81 — `deploy --cmd`

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-35](STUDY-35-push-and-deploy.md) (deploy), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  (the framework's URL variables, `urlVariables`), STUDY-67 (canonical URLs)

## 1. How Convex does it

`npm-packages/convex/src/cli/lib/command.ts:373-381` declares the deploy options:

- `--cmd <command>`: "Command to run as part of deploying your app (e.g. `vite build`). This command can
  depend on the environment variables specified in `--cmd-url-env-var-name` being set."
- `--cmd-url-env-var-name <name>`: "Environment variable name to set Convex deployment URL (e.g.
  `VITE_CONVEX_URL`) when using `--cmd`".

`deploy`'s help (`cli/deploy.ts:51-58`) makes it step 1: "Run a command if specified with `--cmd`, with the
deployment URL available as an environment variable", before the typecheck, codegen, bundle and push. "If any
step fails, the next steps do not run."

`runCommand` (`cli/lib/deploy2.ts:527-580`):

1. **The variable names.**
   - The URL variable is `--cmd-url-env-var-name`, else `suggestedEnvVarNames`: the framework from
     `package.json` (`lib/envvars.ts:135-…`: `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `EXPO_PUBLIC_`, `PUBLIC_`,
     …).
   - The site variable is always the suggested one.
2. **The spinner.** It shows ``Running '<cmd>' with environment variables "<url var>" and "<site var>"
   set...``, followed by ` [dry run]` on a dry run.
3. **The run.** Unless it is a dry run:
   - it reads the deployment's canonical URLs (`GET /api/v1/get_canonical_urls`);
   - it runs the command with `spawnSync(cmd, { env: {...process.env, [urlVar]: cloud, [siteVar]: site},
     stdio: "inherit", shell: true })`.
4. **A failure.** A non-zero exit crashes the deploy with exit code 1 and the message `'<cmd>' failed`.
5. **The result.** It logs `` ✔ Ran "<cmd>" with environment variables … set `` (on a dry run: "Would have
   run").

## 2. What an app can observe

- A build pipeline can run `deploy --cmd "vite build"`. The build sees the deployment's URL in the variable
  its framework reads, and its HTTP-actions URL in the site variable.
- If the build fails, nothing is pushed.
- On a dry run, the command does not run.

## 3. How bunvex does it

`packages/cli/src/deploy.ts`, before `deploy()`, which runs the codegen, bundle, push and typecheck:

- **The variables** come from bunvex's own framework detection (`urlVariables`: `VITE_BUNVEX_URL`, …, the
  names `bunvex dev` already writes to `.env.local`). The URL variable can be overridden with
  `--cmd-url-env-var-name`.
- **The URLs** come from the deployment's canonical URLs (`GET /api/v1/get_canonical_urls`, with the admin
  key).
- **The run** uses `spawnSync` with a shell, from the project directory, with output inherited.
- **The messages** are Convex's: the spinner line, `'<cmd>' failed` with exit code 1, and "Ran" / "Would have
  run".

## 4. Divergences

None new. The variable names are bunvex's, as everywhere else (`urlVariables`; no "convex" in shipped
strings, rule 5).

## 5. Tests

`packages/cli/test/deploy.test.ts`, against a real server, for an app whose `package.json` uses Vite:

- a dry run prints both lines and runs nothing;
- `exit 3` fails the deploy, and nothing is pushed;
- a build writes `$VITE_BUNVEX_URL $VITE_BUNVEX_SITE_URL`, which equal the deployment's canonical URLs, and
  the push follows;
- `--cmd-url-env-var-name MY_URL` sets that variable instead.

Sabotage checks, each failing the test:

- the URL not set;
- a failure ignored;
- the command never run;
- the name flag ignored.
