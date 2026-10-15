---
"@bunvex/cli": patch
---

`bunvex dev`'s local dashboard no longer stops `dev` when another process binds its port between the probe and the bind (two `bunvex dev` starting at once): it moves on to the next free port (STUDY-149).
