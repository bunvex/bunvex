---
"@bunvex/core": patch
---

A schema push walks only the tables Convex walks: a table whose new validator accepts everything the enforced one did (`supersetOfEnforced`), or everything its shape says it holds (`supersetOfShape`), is not walked, as Convex's `Validator::is_subset` and `from_shape`. `evaluate_schema` reports those outcomes too (DV-301, STUDY-106 §7.4). A widening push over 50 000 documents completes in 18 ms instead of 1541 ms.
