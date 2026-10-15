---
"@bunvex/server": patch
---

The error for an HTTP action's streamed body chunk that is not bytes is now worded as bunvex's own (DV-529): `HTTP action response body chunks must be an ArrayBuffer or a view of one, got <type>`, and `HTTP action response body chunks must not be a resizable ArrayBuffer or a view of one`. When it fails, and what the client and the log see, are unchanged.
