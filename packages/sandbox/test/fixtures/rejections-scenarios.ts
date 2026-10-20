// Scenarios of the child's attribution (`rejections.ts`), run in a process of their own (rejections.test.ts): `bun test`
// counts every rejection in its own process as a failure, markers included. As where Bun reports at the end of the
// turn (`asIfReportedLate`, the path Bun 1.4.3 takes, right on every Bun). Prints one JSON line of what each saw.
import { asIfReportedLate, checkpoint, track } from "../../src/rejections.ts";

asIfReportedLate();

function call(id: number) {
  const seen = { failed: [] as unknown[], checked: 0, log: [] as string[] };
  track(id, {
    unhandled: (r) => {
      seen.failed.push(r instanceof Error ? r.message : r);
      seen.log.push("failed");
    },
    checked: () => {
      seen.checked++;
      seen.log.push("checked");
    },
  });
  return seen;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
  return ok();
};
const out: Record<string, unknown> = {};

// Each call's rejections are its own, checkpoints interleaved in one turn.
{
  const a = call(1);
  const b = call(2);
  checkpoint(1, () => void Promise.reject(new Error("a1")));
  checkpoint(2, () => void Promise.reject(new Error("b1")));
  checkpoint(2, () => {});
  await until(() => a.checked > 0 && b.checked > 1);
  out.interleaved = { a: a.failed, b: b.failed, checked: [a.checked > 0, b.checked > 1] };
}
// A call's next checkpoint runs once its last one was checked: a handler added there is too late, as on Convex.
{
  const c = call(3);
  let p!: Promise<never>;
  checkpoint(3, () => {
    p = Promise.reject(new Error("handled one checkpoint late"));
  });
  checkpoint(3, () => {
    c.log.push("second");
    p.catch(() => {});
  });
  await until(() => c.log.includes("second"));
  out.gate = { failed: c.failed, log: c.log.filter((l) => l !== "checked") };
}
// A rejection handled within its checkpoint is no one's.
{
  const d = call(4);
  checkpoint(4, () => {
    const p = Promise.reject(new Error("handled in time"));
    void Promise.resolve().then(() => p.catch(() => {}));
  });
  await until(() => d.checked > 0);
  out.inTime = { failed: d.failed, checked: d.checked > 0 };
}
// An idle child still hears its last marker: nothing else turns the loop before the timer.
{
  let heard!: () => void;
  const checked = new Promise<string>((r) => (heard = () => r("checked")));
  track(5, { unhandled: () => {}, checked: () => heard() });
  checkpoint(5, () => {});
  out.idle = await Promise.race([checked, new Promise<string>((r) => setTimeout(() => r("timer"), 300))]);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
