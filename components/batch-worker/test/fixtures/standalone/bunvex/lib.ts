// The component's functions pushed as an app's, as upstream's tests run them (`convexTest(schema, modules)` over the
// component's own directory): `lib:ping`, `loop:loop` and `monitor:monitor` are the app's, and `t.run` reads
// `workers` and `workerState` directly.
export * from "../../../../src/component/lib.ts";
