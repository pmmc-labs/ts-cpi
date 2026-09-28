#!/usr/bin/env bash
# Runs one scenario (ramp by default) against the gateway three ways: plain,
# under the monitor at 4 frames a second, and under it at 30. It starts and
# stops the gateway itself, so nothing else may be using port 8080. The
# monitor runs on a pseudo-terminal (tools/pty_run.py); its last screen is
# saved beside the results.
#
#   examples/gateway/scenarios/compare.sh [scenario]
cd "$(dirname "$0")"
HERE="$(pwd)"
ROOT="$(cd ../../.. && pwd)"
SCENARIO="${1:-ramp}"
OUT="${OUT:-$(mktemp -d)}"
FILES="examples/gateway/gateway.slight"

run_mode() {
    local name=$1
    shift
    ( cd "$ROOT" && "$@" ) > "$OUT/$name.gateway.log" 2>&1 &
    local pid=$!
    "$HERE/$SCENARIO.sh" > "$OUT/$name.txt"
    curl -s -o /dev/null http://127.0.0.1:8080/system/quit
    wait $pid
    echo "######## $SCENARIO, $name"
    cat "$OUT/$name.txt"
}

run_mode plain node bin/cpi.ts $FILES examples/gateway/plain.slight
run_mode monitor-4fps python3 tools/pty_run.py --screen "$OUT/monitor-4fps.screen" -- \
    node bin/cpi.ts $FILES examples/gateway/monitor.slight
run_mode monitor-30fps python3 tools/pty_run.py --keys ff --after 1 --screen "$OUT/monitor-30fps.screen" -- \
    node bin/cpi.ts $FILES examples/gateway/monitor.slight
echo "results and the monitor's last screens are in $OUT"
