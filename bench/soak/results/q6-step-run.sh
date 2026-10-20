#!/bin/bash
# Runs soak-nightly.yml's soak step as the runner would: the step's `run:` taken from the YAML verbatim, under
# bash -e, the job's env from the YAML, GITHUB_ENV / GITHUB_STEP_SUMMARY as files. usage: step-run.sh <repo> <name> <event> [minutes]
set -u
REPO=$1 NAME=$2 EVENT=$3 MIN=${4:-45}
OUT=/root/bunvex-q6/runs/$NAME; mkdir -p "$OUT"
export PATH=/root/bunvex-q6/bun142:$PATH
cd "$REPO" && rm -rf .data/soak
bun -e '
const y = Bun.YAML.parse(await Bun.file(".github/workflows/soak-nightly.yml").text());
const job = Object.values(y.jobs).find((j) => j.steps?.some((s) => s.name?.startsWith("Soak for")));
const step = job.steps.find((s) => s.name?.startsWith("Soak for"));
await Bun.write(process.argv[1] + "/step.sh", step.run);
await Bun.write(process.argv[1] + "/job-env.json", JSON.stringify(job.env));
' "$OUT"
export EVENT_NAME=$EVENT MINUTES=$MIN REPORT_ONLY_INPUT=""
export SOAK_REPORT_ONLY=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).SOAK_REPORT_ONLY ?? "")' "$OUT/job-env.json")
export GITHUB_ENV=$OUT/github.env GITHUB_STEP_SUMMARY=$OUT/summary.md
: > "$GITHUB_ENV"; : > "$GITHUB_STEP_SUMMARY"
# The step's only expression is github.event_name, as in the job: replaced by the event.
sed -i 's/\${{ github.event_name }}/'"$EVENT"'/g' "$OUT/step.sh"
echo "SOAK_REPORT_ONLY='$SOAK_REPORT_ONLY' bun $(bun --version)"
bash -e "$OUT/step.sh"; code=$?
echo "STEP EXIT CODE: $code"
cp -r .data/soak "$OUT/soak"
exit $code
