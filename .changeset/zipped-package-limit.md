---
"@bunvex/server": patch
---

A push is no longer refused for its zipped size, as on Convex since it dropped that limit: the 90 000 000-byte zipped check and its `MAX_ZIPPED_PACKAGES_SIZE` knob are gone. The 230 000 000-byte unzipped limit stays.
