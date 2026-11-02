---
"@bunvex/core": patch
---

A query's read set and table figures no longer depend on whether the deployment's run state or its environment variables were cached. Before, a run that read them cold lost the read of the table mapping: a table created or deleted afterwards did not rerun the query or invalidate its cached result. It also counted the variables' rows in the function's table figures.
