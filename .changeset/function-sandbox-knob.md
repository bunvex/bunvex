---
"@bunvex/server": minor
---

The function sandbox knob (AD-44): `BUNVEX_FUNCTION_SANDBOX` (and `--function-sandbox` on `bunvex-local-backend`,
which wins over it) chooses where functions run, `vm` (the default, as before) or `process`, and
`BUNVEX_FUNCTION_SANDBOX_ISOLATION` (`auto`, `namespaces`, `landlock`, `none`) its layers. `process` is not available
yet: a start that asks for it fails with a message saying so. A value outside the lists fails at start too. Every
load of pushed code now goes through one executor factory.
