---
"@bunvex/server": patch
"@bunvex/core": patch
"@bunvex/values": patch
---

`BUNVEX_FUNCTION_SANDBOX=process` (with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, no OS isolation yet) runs pushed queries and mutations in a separate process, each `ctx` operation on the server's transaction (STUDY-171 §8); actions, HTTP actions, components and rooms say they are not available there yet.
