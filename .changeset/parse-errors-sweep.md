---
"@bunvex/server": minor
---

The admin routes read their query string and JSON body as Convex's extractors do, before checking the
caller's operation (checked against Convex's binary):

- Query-string errors read "Failed to deserialize query string: …", with serde_urlencoded's reasons.
- Body errors carry axum's prefixes and serde's messages and positions, for every field type.
- A body needs `Content-Type: application/json`.
- A field given twice is refused.

Also:
- `list_audit_log_events` answers 400 `InvalidCursor` for a cursor that does not parse.
- Streaming export's selection arguments fall back to everything, as Convex's untagged `SelectionArg` does.
- `set_expiration` reads its nanoseconds exactly.
