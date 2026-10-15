// Where a document id leads (STUDY-163 §2), as Convex's `documentHref`.
import { expect, test } from "bun:test";
import { referenceTarget } from "../src/database/reference.ts";

test("a file to Files, a scheduled run to the scheduled functions, a user table's to its document", () => {
  expect(referenceTarget("_file_storage", "f1")).toEqual({ to: "/files", search: { file: "f1" } });
  expect(referenceTarget("_scheduled_jobs", "j1")).toEqual({ to: "/schedules/functions" });
  expect(referenceTarget("users", "u1")).toEqual({
    to: "/database/$table",
    params: { table: "users" },
    search: { doc: "u1" },
  });
  // a system table no screen shows (Convex reports it as unsupported)
  expect(referenceTarget("_tables", "t1")).toBeNull();
});
