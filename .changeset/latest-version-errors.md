---
"@bunvex/cli": patch
---

When `bunvex dev` cannot find the latest local backend version, it says why, as Convex's CLI does: "<host> returned <status>: <body>", "Invalid response missing version field" or "Failed to fetch latest backend version". Before, every case read "could not find the latest bunvex local backend (is GitHub reachable?)". With a version already downloaded, it prints the reason, then "Failed to get latest version from GitHub, using downloaded version <version>". A version found is looked up once per process.
