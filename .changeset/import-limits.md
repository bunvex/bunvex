---
"@bunvex/server": patch
---

Imports are bounded as Convex's. An upload part past 64 MiB is a 400 `ImportPartTooLarge` (`MAX_IMPORT_UPLOAD_PART_BYTES`). A JSON Lines line, or a CSV record, past 16 MiB with its line ending fails the import with `JsonLineTooLarge` / `CsvRecordTooLarge` (`SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES`). A JSON Lines line that is not UTF-8 is reported in Rust's words. A failed import's message is no longer prefixed "Hit an error while importing:" when the error is one of Convex's own import errors (a bad row, a missing CSV field, a BOM, an existing table), as on Convex.
