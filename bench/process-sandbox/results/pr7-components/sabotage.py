import subprocess, os, re, json, shutil, sys
# The sabotage checks of STUDY-171 §15.6: each break applied alone, the tests run under process, the file restored.
#   python3 bench/process-sandbox/results/pr7-components/sabotage.py [index ...]
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
TESTS=["packages/sandbox/test/component-parity.test.ts"]
SERVER=["packages/server/test/component-runtime.test.ts"]
breaks=[
 ("components in a child of their own (`own` the default)","packages/sandbox/src/executor.ts",
  'const { components = "shared", ...spawn } = options;','const { components = "own", ...spawn } = options;',TESTS),
 ("the child ignores `unload`","packages/sandbox/src/child.ts",
  'versions.delete((m as Extract<ToChild, { t: "unload" }>).version);','void m;',TESTS),
 ("the host sends no `unload`","packages/sandbox/src/executor.ts",
  'if (!child.failure) child.send({ t: "unload", version: slot.versionId });','void child;',TESTS),
 ("the push keeps each definition's analyzed version (no release)","packages/server/src/push.ts",
  'executor.release?.(loaded);','void loaded;',TESTS),
 ("the push analyzes each definition in a child of its own (no `beside`)","packages/server/src/push.ts",
  'await loadCode(c.functions, { ...config, env: {} }, executor, beside);','await loadCode(c.functions, { ...config, env: {} }, executor);',TESTS),
 ("an instance's version loaded in a child of its own (no `beside` at the install)","packages/server/src/server.ts",
  'await loadComponentCode(engine, modulesStore, meta._id, executor, liveVersion ?? undefined);','await loadComponentCode(engine, modulesStore, meta._id, executor);',TESTS),
 ("the server releases no replaced or removed instance's version","packages/server/src/server.ts",
  'if (before && before !== next) executor.release?.(before);','void before;',TESTS),
 ("`installed` retires the instances' versions too","packages/sandbox/src/executor.ts",
  'else if (v !== version && !v.beside) {','else if (v !== version) {',TESTS),
 ("a new child loads only the first version again","packages/sandbox/src/executor.ts",
  '''          this.held = load.held;
        }
        return child;''','''          this.held = load.held;
          break;
        }
        return child;''',TESTS),
 ("a component's variables not sent to the child","packages/server/src/functions.ts",
  '  if (vars)\n    reader.variables = {','  if (vars && false)\n    reader.variables = {',TESTS+SERVER),
 ("a component's variables sent unbound (the deployment's)","packages/server/src/functions.ts",
  'deployment: boundVariables(c, vars),','deployment: vars,',TESTS+SERVER),
 ("the built-in site URL sent without the instance's prefix","packages/server/src/functions.ts",
  'builtin: prefixed === undefined ? builtin : { ...builtin, BUNVEX_SITE_URL: prefixed },','builtin,',TESTS),
 ("the host takes a `loaded` whose `held` is not a count","packages/sandbox/src/protocol.ts",
  'held: int(m.held, "loaded.held"),','held: m.held as number,',["packages/sandbox/test/protocol.test.ts"]),
 ("the push refuses components under process again","packages/server/src/push.ts",
  '  for (const c of pushed.components) {\n    // Convex','  if (executor.kind === "process" && pushed.components.length) throw new Error("no");\n  for (const c of pushed.components) {\n    // Convex',TESTS),
]
only=sys.argv[1:] 
def run(tests):
  env=dict(os.environ, BUNVEX_FUNCTION_SANDBOX="process", BUNVEX_FUNCTION_SANDBOX_ISOLATION="none")
  r=subprocess.run(["bun","test","--preload","./packages/sandbox/test/process-preload.ts",*tests],cwd=ROOT,env=env,capture_output=True,text=True,timeout=900)
  out=r.stdout+r.stderr
  fails=[l for l in out.splitlines() if l.startswith("(fail)")]
  m=re.search(r"(\d+) pass",out); f=re.search(r"(\d+) fail",out)
  return int(m.group(1)) if m else -1, int(f.group(1)) if f else -1, fails
base=subprocess.run(["git","diff"],cwd=ROOT,capture_output=True,text=True).stdout
res=[]
for i,(name,path,old,new,tests) in enumerate(breaks):
  if only and str(i) not in only: continue
  p=os.path.join(ROOT,path); src=open(p).read()
  if src.count(old)!=1: res.append({"break":name,"error":"pattern count %d"%src.count(old)}); print(res[-1]); continue
  open(p,"w").write(src.replace(old,new))
  try:
    ok,fail,names=run(tests)
  finally:
    open(p,"w").write(src)
  after=subprocess.run(["git","diff"],cwd=ROOT,capture_output=True,text=True).stdout
  assert after==base, "tree not restored"
  res.append({"break":name,"pass":ok,"fail":fail,"failing":[re.sub(r" \[[\d.]+ms\]$","",n) for n in names]})
  print(json.dumps(res[-1]),flush=True)
