# sabotage.py <tree>: each break of breaks.py applied to the tree alone, the PR's sandbox tests run, the file restored
# from its saved copy and compared byte for byte before the next. Prints one line per break.
import subprocess, sys, shutil, filecmp, re, json
sys.path.insert(0, "/root/bunvex-pr6")
from breaks import BREAKS
tree = sys.argv[1]
TESTS = ["packages/sandbox/test/http-parity.test.ts", "packages/sandbox/test/http-limits.test.ts", "packages/sandbox/test/streams.test.ts"]
only = sys.argv[2:] 
for i, (name, f, old, new) in enumerate(BREAKS):
    if only and str(i) not in only: continue
    path = f"{tree}/{f}"
    shutil.copy(path, "/root/bunvex-pr6/saved")
    s = open(path).read()
    if s.count(old) != 1:
        print(json.dumps({"break": name, "error": f"old text found {s.count(old)} times"})); continue
    open(path, "w").write(s.replace(old, new))
    # A guard against a race: the case it guards, run 12 times; how many runs failed.
    races = {"An operation still running": "formUnawaited", "The body's end and the call's": "bodyFetches|bodyWrites|bodyCallsCtx|bodyReadsEnv|streamSlow|streamTyped|stream$"}
    race = next((t for k, t in races.items() if name.startswith(k)), None)
    if race:
        runs = [subprocess.run(["timeout", "300", "bun", "test", TESTS[0], "-t", race], cwd=tree, capture_output=True, text=True, errors="replace") for _ in range(12)]
        failed = sum(1 for r in runs if re.search(r"^ *[1-9]\d* fail", r.stdout + r.stderr, re.M))
        shutil.copy("/root/bunvex-pr6/saved", path)
        assert filecmp.cmp("/root/bunvex-pr6/saved", path, shallow=False)
        print(json.dumps({"break": name, "failing": failed, "count": failed, "tests": [f"{race}: {failed} runs of 12 failed"]}), flush=True)
        continue
    r = subprocess.run(["timeout", "900", "bun", "test", *TESTS], cwd=tree, capture_output=True, text=True, errors="replace")
    out = r.stdout + r.stderr
    fails = sorted(set(re.findall(r"^\(fail\) (.*?) \[", out, re.M)))
    shutil.copy("/root/bunvex-pr6/saved", path)
    assert filecmp.cmp("/root/bunvex-pr6/saved", path, shallow=False)
    m = re.search(r"^ *(\d+) fail", out, re.M)
    print(json.dumps({"break": name, "failing": len(fails), "count": int(m.group(1)) if m else None, "tests": fails}), flush=True)
