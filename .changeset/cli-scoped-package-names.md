---
"@bunvex/cli": patch
---

The CLI names the packages apps install, `@bunvex/*` (npm will not allow `bunvex`; STUDY-146 §8). The update notice in `dev` and `deploy` asks the registry for `@bunvex/cli` (`/@bunvex%2Fcli/latest`): it asked for `bunvex`, which does not exist, so it never printed. `bunvex update` prints `bun update --latest '@bunvex/*'`, which upgrades every `@bunvex/*` package together, and links `@bunvex/server`'s changelog. Codegen writes `@bunvex/server` and `@bunvex/values` imports unless the app's `package.json` depends on the repository's private `bunvex` aggregate; a missing `package.json`, or one without bunvex, used to get `bunvex/*`.
