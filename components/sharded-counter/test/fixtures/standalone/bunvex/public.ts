// The component's functions pushed as an app's, as upstream's tests run them (`convexTest(schema, modules)` over
// the component's own directory): `public:add` and the others are the app's, and `t.run` reads `counters` directly.
export * from "../../../../src/component/public.ts";
