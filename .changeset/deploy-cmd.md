---
"@bunvex/cli": minor
---

`bunvex deploy --cmd <command>` runs a build command first, in a shell from the project, with the deployment's canonical URLs in the variables the framework reads (`VITE_BUNVEX_URL` / `VITE_BUNVEX_SITE_URL`, …; `--cmd-url-env-var-name` for the first); a failing command stops the deploy, and a dry run only says what it would run, as Convex's `deploy --cmd` (STUDY-81).
