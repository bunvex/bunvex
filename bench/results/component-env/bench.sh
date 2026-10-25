#!/bin/bash
# The nested-call bench on an idle VPS: waits until no process uses the CPU (checked with ps, nothing stopped), then
# two rounds, interleaved: main (base) and this branch (head) under vm; #822 (pr822) and #822 with this branch (m822)
# under vm and process. Output in ~/bunvex-component-env/bench/.
R=~/bunvex-component-env
mkdir -p $R/bench
# Busy: any process over 5% CPU (idle leftovers of other sessions, at 0.3%, do not count).
others() { ps -eo pcpu=,args= | awk '$1 > 5 && $0 !~ /ps -eo|awk/'; }
for i in $(seq 1 360); do
  if [ -z "$(others)" ] && [ "$(awk '{print int($1)}' /proc/loadavg)" -lt 1 ]; then break; fi
  sleep 10
done
{ date; uptime; ps -eo pid,pcpu,args --sort=-pcpu | head -6; } > $R/bench/idle.txt
for round in 1 2; do
  for t in base head pr822 m822; do
    (cd $R/$t && bun bench/component-env.ts 2000 --sandbox=vm) > $R/bench/$t-vm-$round.txt 2>&1
  done
  for t in pr822 m822; do
    (cd $R/$t && bun bench/component-env.ts 2000 --sandbox=process) > $R/bench/$t-process-$round.txt 2>&1
  done
done
{ date; uptime; } >> $R/bench/idle.txt
echo done > $R/bench/bench.done
