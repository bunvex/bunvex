// The mutation report (reports/mutation/mutation.json, Stryker's JSON reporter) as a Markdown table: per file,
// the mutants the tests noticed (killed or timed out), those they did not (survived, or no test reaches them),
// and the score. Printed to stdout; the weekly workflow writes it to the job summary.
//   bun scripts/mutation-summary.ts [reports/mutation/mutation.json]
export {};

type Mutant = { status: string };
type Report = { files: Record<string, { mutants: Mutant[] }> };

const path = process.argv[2] ?? "reports/mutation/mutation.json";
const report = (await Bun.file(path).json()) as Report;

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

const rows: string[][] = [];
const total = { detected: 0, survived: 0, noCoverage: 0 };
for (const [file, { mutants }] of Object.entries(report.files).sort(([a], [b]) => a.localeCompare(b))) {
  const detected = mutants.filter((m) => DETECTED.has(m.status)).length;
  const survived = mutants.filter((m) => m.status === "Survived").length;
  const noCoverage = mutants.filter((m) => m.status === "NoCoverage").length;
  const scored = mutants.filter((m) => DETECTED.has(m.status) || UNDETECTED.has(m.status)).length;
  total.detected += detected;
  total.survived += survived;
  total.noCoverage += noCoverage;
  const score = scored === 0 ? "-" : `${((100 * detected) / scored).toFixed(1)}%`;
  rows.push([file, String(detected), String(survived), String(noCoverage), score]);
}
const scored = total.detected + total.survived + total.noCoverage;
rows.push([
  "**all**",
  String(total.detected),
  String(total.survived),
  String(total.noCoverage),
  scored === 0 ? "-" : `${((100 * total.detected) / scored).toFixed(1)}%`,
]);

console.log("| File | Detected | Survived | No coverage | Score |");
console.log("|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);
