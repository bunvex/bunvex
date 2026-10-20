---
"@bunvex/core": patch
"@bunvex/server": patch
---

An instance secret written with a `0x` or `0X` prefix is accepted, as Convex accepts it (`--instance-secret`, `INSTANCE_SECRET`, `keygen admin-key`, `bunvex admin-key`), and is the same secret as its bare spelling: the same admin keys, cursors and storage, export and import tokens. A hex secret in uppercase now derives the same keys as in lowercase too. `0x0x…` and `0x` alone are still refused with Convex's messages.
