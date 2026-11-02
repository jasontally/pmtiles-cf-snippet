#!/bin/bash
# Measure the CPU a snippet spends per request, in a local workerd.
#
#   tools/bench-snippet/run.sh <snippet.js> [mode] [n] [conc] [originBytes] [chunk]
#
#   mode          tile | tilestart | tileend | tile2 | leaf | head   (default tile)
#   originBytes   size of every part the mock origin serves         (default 1000000;
#                 use 160000 for leaf and 16384 for head)
#   FAIL=4        env: every 4th origin reply is a 503
#   WORKERD=path  env: the workerd binary (default: newest one in the npx cache)
#   INSPECT=1     env: also print a V8 CPU profile of a run (prof.mjs)
#
# The snippet source may have `export` lines; they are stripped, because workerd
# rejects exports that are not handlers. The snippet's fetch() is pointed at a
# mock origin on 127.0.0.1:9100 through globalOutbound, so the hostnames in the
# snippet do not matter. workerd, the origin and the client run on cores 1, 2
# and 3, so they do not share a core. CPU is read from /proc, so it includes
# the socket work in workerd. Local loopback is not the production transport.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$1"; MODE="${2:-tile}"; N="${3:-3000}"; CONC="${4:-1}"; SIZE="${5:-1000000}"; CHUNK="${6:-65536}"
WORKERD="${WORKERD:-$(ls -t "$HOME"/.npm/_npx/*/node_modules/@cloudflare/workerd-linux-64/bin/workerd | head -1)}"
WORK="${TMPDIR:-/tmp}/bench-snippet.$$"
mkdir -p "$WORK"
export LEAF_OFFSET="$(grep -o 'leafOffset: [0-9]*' "$SRC" | head -1 | grep -o '[0-9]*')"
sed -E 's/^export (const|function)/\1/' "$SRC" > "$WORK/w.js"
cat > "$WORK/w.capnp" <<CFG
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .w),
    (name = "origin", external = (address = "127.0.0.1:9100", http = ())),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:8787", http = (), service = "main") ]
);
const w :Workerd.Worker = (
  modules = [ (name = "w.js", esModule = embed "w.js") ],
  compatibilityDate = "2026-10-01",
  globalOutbound = "origin",
);
CFG
trap 'kill $OP $WP 2>/dev/null; rm -rf "$WORK"' EXIT
taskset -c 2 node "$HERE/origin.mjs" 9100 "$SIZE" "$CHUNK" $FAIL > "$WORK/origin.log" 2>&1 & OP=$!
INSPECTOR=()
[ -n "$INSPECT" ] && INSPECTOR=(--inspector-addr=127.0.0.1:9229)
taskset -c 1 "$WORKERD" serve "$WORK/w.capnp" "${INSPECTOR[@]}" > "$WORK/workerd.log" 2>&1 & WP=$!
sleep 1.5
if [ -n "$INSPECT" ]; then
  (taskset -c 3 node "$HERE/bench.mjs" $WP "$N" "$CONC" "$MODE" > "$WORK/bench.out" 2>&1 &)
  sleep 2; node "$HERE/prof.mjs" 9229 3; cat "$WORK/bench.out"
else
  taskset -c 3 node "$HERE/bench.mjs" $WP "$N" "$CONC" "$MODE"
fi
