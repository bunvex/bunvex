#!/usr/bin/env python3
# Each break applied alone to the fix, the server's component-env test (and the oracle's for the first) run, the file
# restored from a saved copy and checked unchanged before the next. Output: one JSON line per break.
import json, os, re, shutil, subprocess, sys
ROOT = os.path.expanduser("~/bunvex-component-env/head")
F = os.path.join(ROOT, "packages/server/src/functions.ts")
ENV = dict(os.environ, PATH=os.path.expanduser("~/bunvex-component-env/bin") + ":" + os.environ["PATH"])
BREAKS = [
    ("no switch: a nested call keeps the caller's reader",
     "calleeComponent?.id === component?.id ? null : await this.nestedEnv(tx, calleeComponent)", "null", True),
    ("the switch into a component only (back into the app keeps the component's reader)",
     "calleeComponent?.id === component?.id ? null :", "calleeComponent === undefined || calleeComponent?.id === component?.id ? null :", False),
    ("the stale-snapshot query keeps the caller's reader",
     "withCalleeEnv(env, () => this.invoke(f, stale, a, depth + 1))", "this.invoke(f, stale, a, depth + 1)", False),
    ("a component's reader checks no name",
     "    checkEnvVarName(name);\n    const b = c.env.get(name);", "    const b = c.env.get(name);", True),
    ("the per-transaction cache keyed by the transaction only (the first namespace's reader for every callee)",
     "const key = component?.id ?? null;", "const key = null;", False),
    ("a component's reader records no read (not in the read set)",
     "if (component) return componentEnv(component, read, builtin);",
     "if (component) return componentEnv(component, (n) => read.vars.get(n), builtin);", False),
]
def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=600)
    out = p.stdout + p.stderr
    return [l for l in out.splitlines() if l.startswith("(fail)")], re.findall(r"^ (\d+) pass$", out, re.M)
orig = open(F).read()
saved = F + ".saved"
shutil.copy(F, saved)
for name, old, new, oracle in BREAKS:
    assert orig.count(old) == 1, name
    open(F, "w").write(orig.replace(old, new))
    fails, passes = run(["bun", "test", "packages/server/test/component-env.test.ts"], ROOT)
    row = {"break": name, "server_failed": len(fails), "server_failing": fails, "server_pass": passes}
    if oracle:
        f2, p2 = run(["bun", "test", "test/component-env.test.ts"], os.path.join(ROOT, "packages/differential"))
        row.update(oracle_failed=len(f2), oracle_failing=f2, oracle_pass=p2)
    shutil.copy(saved, F)
    assert open(F).read() == orig
    print(json.dumps(row), flush=True)
os.remove(saved)
fails, passes = run(["bun", "test", "packages/server/test/component-env.test.ts"], ROOT)
print(json.dumps({"break": "none (restored)", "server_failed": len(fails), "server_pass": passes}), flush=True)
