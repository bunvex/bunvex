---
"@bunvex/cli": patch
---

`bunvex dev` refuses a local backend version that is not a release's name (`precompiled-YYYY-MM-DD-…`), from `--local-backend-version`, `config.json` or the releases API, with "Invalid local backend version", before the version reaches a cache path or a download URL, as Convex's CLI does.
