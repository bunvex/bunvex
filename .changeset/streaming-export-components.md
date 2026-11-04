---
"@bunvex/server": patch
---

Streaming export and data sync now cover every component. `list_snapshot`, `document_deltas` and `/api/v1/data/sync` stream each component's tables, with the component's path in `_component` (or `component`) instead of `""`. `json_schemas` and `get_table_column_names` describe each component's tables under its path. Selections by component (`component=…`) now select that component's tables.
