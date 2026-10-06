---
"@bunvex/server": patch
---

`_modules` and `_source_packages` rows have Convex's shapes (STUDY-134): a module's `sha256` in base64, its analysis with `sourceMapped` and int64 positions, a package's `sha256` as bytes, `packageSize` as int64 zipped and unzipped sizes, `externalPackageId` and `nodeVersion` null. The pushed `schema.js` and `auth.config.js` are stored as modules, as Convex's.
