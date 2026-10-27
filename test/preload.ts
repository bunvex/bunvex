// The root test run's preload: the engine's own values are frozen (TEST-01 §6), so a function or a listener
// that mutates one throws in the tests instead of silently changing stored data.
process.env.BUNVEX_FREEZE_ENGINE_VALUES ??= "1";

// Every engine's calls round-trip through the call boundary's codec (STUDY-194 Q7, owner, 2026-10-27): the suites
// exercise the text a worker will receive, while a server outside the tests passes the same objects without it.
// Imported after the line above, which the engine reads when it loads.
const { roundTripCallsByDefault } = await import("../packages/core/src/call-runner.ts");
roundTripCallsByDefault();
