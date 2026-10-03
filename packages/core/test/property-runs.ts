/**
 * How many cases a property runs: `base` × BUNVEX_PROPERTY_MULTIPLIER (default 1). CI runs the default; the
 * nightly job raises it — as Convex scales its proptest cases by an environment multiplier
 * (CONVEX_PROPTEST_MULTIPLIER in crates/value/src/sorting.rs, convex-backend bea52bde0). TEST-01 §2.
 */
export const runs = (base: number) => base * Math.max(1, Number(process.env.BUNVEX_PROPERTY_MULTIPLIER ?? 1));
