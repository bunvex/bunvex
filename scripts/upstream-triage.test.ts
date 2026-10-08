// The daily triage of Convex's commits (STUDY-138): how a commit is sorted by its paths and subject, and the
// digest the workflow posts.
import { describe, expect, test } from "bun:test";
import { areaOf, type Commit, digest, referenceFrom, triage } from "./upstream-triage.ts";

const commit = (subject: string, files: string[]): Commit => ({
  sha: "a".repeat(40),
  date: "2026-10-08",
  subject,
  files,
});

describe("areaOf", () => {
  test("runtime crates, the client package, the web runtime and the dashboard are areas", () => {
    expect(areaOf("crates/database/src/committer.rs")).toBe("runtime");
    expect(areaOf("npm-packages/convex/src/server/router.ts")).toBe("client");
    expect(areaOf("npm-packages/udf-runtime/src/url.ts")).toBe("web");
    expect(areaOf("crates/webcrypto/src/lib.rs")).toBe("web");
    expect(areaOf("npm-packages/dashboard-common/src/x.tsx")).toBe("dashboard");
  });

  test("docs, demos, tests, lockfiles and cloud-only crates are not", () => {
    expect(areaOf("npm-packages/docs/docs/limits.mdx")).toBeNull();
    expect(areaOf("npm-packages/private-demos/a/b.ts")).toBeNull();
    expect(areaOf("crates/database/src/tests/committer.rs")).toBeNull();
    expect(areaOf("crates/isolate/src/environment_test.rs")).toBeNull();
    expect(areaOf("Cargo.lock")).toBeNull();
    expect(areaOf("crates/managed_export/src/lib.rs")).toBeNull();
    expect(areaOf("crates/database/README.md")).toBeNull();
  });
});

describe("triage", () => {
  test("a fix in the engine or the client package is urgent", () => {
    expect(triage(commit("Fix repeatable timestamp bump re-arm race", ["crates/database/src/committer.rs"])).kind).toBe(
      "urgent",
    );
    expect(
      triage(
        commit("Restore table count deltas when a subtransaction rolls back", ["crates/database/src/transaction.rs"]),
      ).kind,
    ).toBe("urgent");
    expect(triage(commit("Fix error formatting", ["npm-packages/convex/src/values/value.ts"])).kind).toBe("urgent");
  });

  test("a feature, or a fix outside the core, waits for the weekly bump", () => {
    expect(triage(commit("Write throughput limiting based on rows / second", ["crates/database/src/x.rs"])).kind).toBe(
      "weekly",
    );
    expect(triage(commit("Fix FormData with null content-type", ["npm-packages/udf-runtime/src/form.ts"])).kind).toBe(
      "weekly",
    );
  });

  test("a fix only in tests or docs is ignored", () => {
    const t = triage(commit("Fix flaky test", ["crates/database/src/tests/a.rs", "npm-packages/docs/x.mdx"]));
    expect([t.kind, t.areas]).toEqual(["ignored", []]);
  });
});

test("the reference comes from docs/parity/upstream.md", async () => {
  expect(referenceFrom("- **Reference commit:** `d8bdde0a1b`\n")).toBe("d8bdde0a1b");
  expect(() => referenceFrom("nothing")).toThrow("Reference commit");
  const file = await Bun.file(new URL("../docs/parity/upstream.md", import.meta.url)).text();
  expect(referenceFrom(file)).toMatch(/^[0-9a-f]{7,40}$/);
});

test("the digest lists each group, with links, and escapes table pipes", () => {
  const md = digest(
    [triage(commit("Fix a | race", ["crates/database/src/a.rs"])), triage(commit("Docs", ["npm-packages/docs/a.md"]))],
    "1".repeat(40),
    "2".repeat(40),
  );
  expect(md).toContain("2 (1 urgent, 0 for the weekly bump, 1 ignored)");
  expect(md).toContain("https://github.com/get-convex/convex-backend/commit/aaaaaaaaaa");
  expect(md).toContain("Fix a \\| race");
});
