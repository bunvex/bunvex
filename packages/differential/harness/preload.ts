// Preloaded by every test file of this package (bunfig.toml): once the run ends, every backend the harness launched
// and a test did not stop is stopped, by its own handle (`stopEveryBackend`).
import { afterAll, setDefaultTimeout } from "bun:test";
import { stopEveryBackend } from "./backends.ts";

// Bun 1.4.4 does not apply `[test] timeout` from bunfig.toml, so the runner's 5 s default stands. Starting
// Convex's backend and bunvex's on a cold runner takes longer than that (the first program of a run).
setDefaultTimeout(180_000);

afterAll(() => stopEveryBackend());
