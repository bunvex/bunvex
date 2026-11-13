---
"@bunvex/core": patch
"@bunvex/server": patch
---

`bunvex-local-backend keygen` no longer prints a knob's "Overriding …" line on stdout, where it ended up in the admin key a script (or `bunvex dev`) read; the server still logs it.
