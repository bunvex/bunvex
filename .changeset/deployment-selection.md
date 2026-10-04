---
"@bunvex/cli": patch
---

The CLI chooses its deployment as Convex's does.
- `--env-file` is the only source when given. The environment used to win over it, so `--env-file prod.env` in a shell with `BUNVEX_SELF_HOSTED_URL` set acted on the shell's deployment.
- A missing env file is an error ("env file does not exist"), as is one that names no deployment.
- `--url` counts only together with `--admin-key`.
- A variable set but empty is unset; `.env.local` and `.env` do not fill it.
- `BUNVEX_DEPLOYMENT` and the self-hosted variables may not be set together.
