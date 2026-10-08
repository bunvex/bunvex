---
"@bunvex/server": minor
"@bunvex/values": minor
---

Function arguments are checked against Convex's value limits before the call (DV-439): an array over 8192 elements
or an object over 1024 fields fails with Convex's message ("Invalid arguments for <path>: Array length is too long
(…)"; a nested call's "Invalid argument `args` for `runUdf`: …"; the scheduler's; a system function's "Uncaught
Error: Invalid arguments: …") instead of running. `measureRawValue` reports the first such container as `tooBig`.
