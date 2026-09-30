---
"@bunvex/server": minor
"@bunvex/protocol": minor
"@bunvex/core": patch
---

Function errors and log lines as Convex returns them: `BunvexError` data as `errorData`, `[Request ID: …] Server Error` messages with redaction (`REDACT_LOGS_TO_CLIENT`), HTTP 200 for function errors and `{code, message}` for request errors, and `console.*` lines returned as `logLines`.
