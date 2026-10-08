---
"@bunvex/core": patch
---

A start that takes a new store's lease while the first start is between two of the four bootstrap globals no
longer opens with only some of them and fails with "missing _index.by_id global": a store is bootstrapped only
when all four are set, and otherwise its globals are completed from its rows at ts 0 (PERSIST-01 K17).
