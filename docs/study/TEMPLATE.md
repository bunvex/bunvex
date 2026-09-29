# STUDY-NN — <topic>

- **Status:** draft
- **Convex source read:** commit `<sha>` of get-convex/convex-backend
- **Related:** <specs, PRs, other studies>

## 1. How Convex does it

What the implementation does, with file references (`crates/…/file.rs`, `npm-packages/convex/src/…`).
Include the details that shape behaviour: formats, limits, ordering, error messages, edge cases.

## 2. What an app can observe

The contract bunvex must match: API shape, return values, errors, ordering, timing, limits. This is what
"works the same as Convex" means for this feature.

## 3. How bunvex does it

The design, adapted to Bun (one process, pluggable persistence, TypeScript). Which package it lives in.

## 4. Divergences

Every place where bunvex behaves differently from Convex, observable or not, with the reason. Each one is
decided by the owner.

| # | Divergence | Why | Decision |
|---|---|---|---|

## 5. Tests

How we check that bunvex matches: the cases and properties, and ideally the same scenario run against
Convex.

## 6. Open questions
