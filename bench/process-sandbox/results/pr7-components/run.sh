#!/bin/bash
# The runner of STUDY-171 §15.5 on the test VPS: head (this branch) and base (PR 6's branch) side by side in ~/bunvex-pr7.
cd ~/bunvex-pr7
out=results.jsonl
: > $out
for round in 1 2; do
  for n in 1 4 16; do
    for mode in vm shared own; do
      (cd head && bun packages/sandbox/bench/components.ts $n 1000 5 --json --modes=$mode 2>/dev/null | sed "s/^{/{\"tree\":\"head\",\"round\":$round,/") >> $out
    done
    (cd base && bun packages/sandbox/bench/components.ts $n 1000 5 --json --modes=vm 2>/dev/null | sed "s/^{/{\"tree\":\"base\",\"round\":$round,/") >> $out
  done
done
echo done >> $out.done
