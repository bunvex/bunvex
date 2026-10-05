// The root test run's preload: the engine's own values are frozen (TEST-01 §6), so a function or a listener
// that mutates one throws in the tests instead of silently changing stored data.
process.env.BUNVEX_FREEZE_ENGINE_VALUES ??= "1";
