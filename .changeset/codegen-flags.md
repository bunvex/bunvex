---
"@bunvex/cli": patch
---

`bunvex codegen` takes Convex's other flags. `--dry-run` writes nothing and prints `Command would write file: <path>` for each file that would change (and `Command would delete …` for stale entries); the hidden `--debug` prints `# <absolute path>` and every file's contents; the hidden `--commonjs`, or `generateCommonJSApi: true` in `bunvex.json`, also writes `_generated/api_cjs.cjs` and `api_cjs.d.cts` for apps that `require()` the api. `--url` and `--admin-key` are accepted and ignored (codegen needs no deployment); `--component-dir` and `--live-component-sources` are refused until bunvex has components.
