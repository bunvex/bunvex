mkdir -p .data/soak
case "$REPORT_ONLY_INPUT" in
  "") REPORT_ONLY="$SOAK_REPORT_ONLY" ;;
  none) REPORT_ONLY="" ;;
  *) REPORT_ONLY="$REPORT_ONLY_INPUT" ;;
esac
echo "REPORT_ONLY=$REPORT_ONLY" >> "$GITHUB_ENV"
echo "report-only rules: ${REPORT_ONLY:-none}"
set +e
bun bench/soak/soak.ts --minutes "$MINUTES" --out .data/soak --report-only "$REPORT_ONLY" 2>&1 | tee .data/soak/soak.log
code=${PIPESTATUS[0]}
set -e
if [ -f .data/soak/report.md ]; then cat .data/soak/report.md >> "$GITHUB_STEP_SUMMARY"; fi
if [ -f .data/soak/report.json ]; then
  # a report-only rule that failed shows as a warning on the run (the script is JavaScript, not shell)
  # shellcheck disable=SC2016
  bun -e 'const r = JSON.parse(await Bun.file(".data/soak/report.json").text());
    for (const x of r.results) if (!x.pass && x.reportOnly) console.log(`::warning title=${x.rule} (report-only)::${x.detail}`);'
fi
case "$code" in
  0) ;;
  1) if [ "schedule" = pull_request ]; then
       echo "::notice::a rule failed; a ${MINUTES}-minute smoke judges nothing, so only a broken run (exit 2) fails it"
     else exit 1; fi ;;
  *) echo "::error::the soak run itself broke (exit $code)"; exit "$code" ;;
esac
