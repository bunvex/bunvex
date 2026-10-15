---
"@bunvex/cli": patch
---

When a push fails because the auth config reads an environment variable the deployment does not have, the dashboard link `deploy` and `dev` print opens that variable (`settings/environment-variables?var=NAME`), as Convex's. The dashboard's environment variables page adds a row for each `?var=` name.
