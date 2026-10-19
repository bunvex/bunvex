# STUDY-168: tables from bench.ts JSON lines (p50 / mean µs per call; calls/s under concurrency).
#   python3 bench/process-sandbox/summarize.py results/bench-docker.jsonl [key fields...]
# The column of a line is its key fields joined by "/" (default: where, mode, variant, when present).
import json
import sys

path = sys.argv[1]
keys = sys.argv[2:] or ["where", "mode", "variant"]
rows = [json.loads(line) for line in open(path) if line.startswith("{")]
lat, thr, cols = {}, {}, []


def col(r):
    return "/".join(str(r[k]) for k in keys if k in r)


for r in rows:
    c = col(r)
    if c not in cols:
        cols.append(c)
    if r.get("phase") == "latency":
        lat.setdefault(r["fn"], {})[c] = f'{r["p50"]:.0f} / {r["mean"]:.0f}'
    elif r.get("phase") == "throughput":
        thr.setdefault(f'{r["fn"]}, {r["concurrency"]}', {})[c] = str(r["perSec"])
    elif r.get("phase") == "load":
        print(f"{c}: spawn to ready {r.get('spawnToReadyMs')} ms")

print("| Function | " + " | ".join(cols) + " |")
print("|---" * (len(cols) + 1) + "|")
for f, d in list(lat.items()) + list(thr.items()):
    print(f"| {f} | " + " | ".join(d.get(c, "-") for c in cols) + " |")
