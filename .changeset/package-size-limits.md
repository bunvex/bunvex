---
"@bunvex/server": patch
---

A push's package is size-checked as Convex's, first in `start_push`: 90 000 000 bytes zipped (the
`MAX_ZIPPED_PACKAGES_SIZE` knob), then 230 000 000 unzipped (was 230 MiB), each refused at the limit with a 400
`ModulesTooLarge` and Convex's message in binary units (was a plain error at `finish_push`).
