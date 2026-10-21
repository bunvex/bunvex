// The child's attribution of unhandled rejections (`rejections.ts`, STUDY-171 §13) on the path Bun 1.4.3 takes, where
// Bun reports at the end of the turn: each call's rejections are its own however checkpoints interleave, a call's next
// checkpoint waits until its last one was checked, and a child left idle still hears its last marker. The scenarios run
// in a process of their own (`fixtures/rejections-scenarios.ts`).
import { expect, test } from "bun:test";
import { join } from "node:path";

test("the child's attribution, as where Bun reports at the end of the turn", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/rejections-scenarios.ts")], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(JSON.parse(text)).toEqual({
    interleaved: { a: ["a1"], b: ["b1"], checked: [true, true] },
    gate: { failed: ["handled one checkpoint late"], log: ["failed", "second"] },
    inTime: { failed: [], checked: true },
    idle: "checked",
  });
});
