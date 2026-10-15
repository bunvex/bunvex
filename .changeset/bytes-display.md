---
"@bunvex/values": patch
---

Bytes in an error's value display read as Convex's backend shows them, `b"AQI="` (padded standard base64, never cut), instead of `ArrayBuffer(2 bytes)` (STUDY-161 §13).
