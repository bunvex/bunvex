---
"@bunvex/client": minor
"@bunvex/server": minor
---

The client announces its own package version (0.x) instead of the Convex client version it followed (1.46.0).
The server no longer applies Convex's client deprecation thresholds (bunvex sets none of its own yet; a version
that does not parse is still a 400), and it splits big transitions into chunks for every client
(STUDY-139 P1–P3, DV-442).
