// The component's functions pushed as an app's, as upstream's tests run them (`convexTest(schema, modules)` over the
// component's own directory): `lib:rateLimit` and the others are the app's, and `t.run` reads `rateLimits` directly.
// The batch worker the asynchronous mode pings is mounted by bunvex.config.ts, as the component mounts it.
export * from "../../../../src/component/lib.ts";
