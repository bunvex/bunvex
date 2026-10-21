// Preloaded by every test file of this package (bunfig.toml): once the run ends, every backend the harness launched
// and a test did not stop is stopped, by its own handle (`stopEveryBackend`).
import { afterAll } from "bun:test";
import { stopEveryBackend } from "./backends.ts";

afterAll(() => stopEveryBackend());
