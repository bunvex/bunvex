// Clock skew (STUDY-57 §4), preloaded into the server process before anything reads the clock: with
// JEPSEN_CLOCK_SKEW_MS=<ms> set, Date.now() and performance.now() run that far ahead (or behind, if
// negative). Commit timestamps follow the wall clock (STUDY-53), so a server restarted with its clock behind
// must still never assign a timestamp at or below one it, or its predecessor, already made visible.
const skew = Number(process.env.JEPSEN_CLOCK_SKEW_MS ?? 0);
if (skew) {
  const now = Date.now;
  Date.now = () => now() + skew;
  const perf = performance.now.bind(performance);
  performance.now = () => perf() + skew;
}
