// Where a Worker's module is: beside the module that starts it in the sources, at its place under `packages/`
// inside the executable (`scripts/build-binary.ts`).
import { expect, test } from "bun:test";
import { threadEntry } from "../src/thread-entry.ts";

test("from the sources: beside the starting module", () => {
  expect(
    threadEntry("file:///repo/packages/core/src/persistence/sqlite-writer.ts", "core/src/persistence", "w.ts"),
  ).toBe("file:///repo/packages/core/src/persistence/w.ts");
  expect(threadEntry("file:///app/node_modules/@bunvex/server/src/x.js", "server/src", "w.ts")).toBe(
    "file:///app/node_modules/@bunvex/server/src/w.ts",
  );
});

test("inside the executable: under its embedded root", () => {
  expect(threadEntry("file:///$bunfs/root/bunvex-local-backend", "core/src/persistence", "w.ts")).toBe(
    "file:///$bunfs/root/core/src/persistence/w.ts",
  );
  expect(threadEntry("file:///B:/~BUN/root/bunvex-local-backend.exe", "server/src", "w.ts")).toBe(
    "file:///B:/~BUN/root/server/src/w.ts",
  );
});
