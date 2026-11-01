// The component's functions pushed as an app's, as upstream's tests run them (`convexTest(schema, modules)` over the
// component's own directory): `lib:enqueue` and the others are the app's, and `t.run` reads `work` directly.
export * from "../../../../src/component/lib.ts";
