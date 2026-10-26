---
"@bunvex/core": minor
"@bunvex/server": patch
---

The stored data is at Convex's `DATABASE_VERSION` 134 (STUDY-193 A14): a store gets Convex's `_s3_export_state` table (number 556, indexed `by_config_id`), and a store Convex's binary wrote at 134 opens without the "newer" warning. A store at 133 is refused, as any older version is (DV-418): move it with an export, then an import (docs/upgrading.md). The dashboard's `listConfiguredSinks` returns an S3 export's `exportProgress` when the store has its `_s3_export_state` row, as Convex's.
