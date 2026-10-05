---
"@bunvex/values": patch
"@bunvex/server": patch
---

The HTTP API and index writes are faster, with the same output:
- object keys are ordered by UTF-8 bytes without encoding them;
- floats between 1e-5 and 1e16 skip the general layout;
- the latest value-format rewrites are kept, so a cached query's callers share one;
- index keys write ASCII strings without encoding them;
- a request body whose declared length is within the cap is read as is.
