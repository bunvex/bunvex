#!/usr/bin/env bash
# A single-node MongoDB replica set in Docker for CI (bunvex needs a replica set: a flush is a transaction,
# PERSIST-01 C7). Prints the image it started.
#   scripts/ci-mongo.sh <container> [host-port]
# MongoDB 8 first. It refuses to start on Linux kernel 6.19 and newer (SERVER-121912), which some GitHub
# runners have; on that refusal MongoDB 7 runs instead, with a warning. The container sometimes exits right
# after it starts for other reasons: it is started again (3 tries), and its log is printed when it stops.
set -uo pipefail
name=$1
port=${2:-27017}
images=${MONGO_IMAGES:-"mongo:8 mongo:7"}

# start <image>: 0 when it answers a ping, 2 when it refused the kernel, 1 otherwise
start() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "$port:27017" "$1" --replSet rs0 --bind_ip_all >/dev/null || return 1
  for _ in $(seq 1 30); do
    docker exec "$name" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ] && break
    sleep 2
  done
  docker logs "$name" 2>&1 | grep -q 'Linux kernel versions .* incompatibility' && return 2
  return 1
}

up=
for image in $images; do
  for attempt in 1 2 3; do
    start "$image"; s=$?
    [ $s = 0 ] && { up=$image; break 2; }
    if [ $s = 2 ]; then echo "::warning::$image refuses this runner's kernel ($(uname -r), SERVER-121912)"; break; fi
    echo "::warning::$image did not come up (attempt $attempt); its log:"
    docker logs "$name" 2>&1 | tail -n 50
  done
  [ $s = 2 ] || break
done
if [ -z "$up" ]; then echo "MongoDB never came up"; exit 1; fi
docker exec "$name" mongosh --quiet --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]})' >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" mongosh --quiet --eval 'db.hello().isWritablePrimary' | grep -q true && break
  sleep 1
done
echo "MongoDB up: $up"
