---
"@bunvex/values": patch
"@bunvex/server": patch
---

The HTTP API formats its answers faster: object keys are ordered by UTF-8 bytes without encoding them, and floats between 1e-5 and 1e16 skip the general layout. The output is the same.
