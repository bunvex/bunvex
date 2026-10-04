---
"@bunvex/server": patch
---

A file download's egress is the bytes actually sent, as Convex: `dataEgressGb` grows as the body streams (a download the client cuts short counts what went out, a range counts the range), and once it ends one `storage_api_bandwidth` log stream event carries the file's id and those bytes. A HEAD request sends a 0-byte event. In Bun the metered body goes out chunked: a GET download no longer sends `content-length` (HEAD still does; DV-324, pending).
