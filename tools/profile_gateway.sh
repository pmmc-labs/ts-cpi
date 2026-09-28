#!/usr/bin/env bash
# Profiles the gateway under one load scenario: a fresh plain gateway under
# node --cpu-prof, the load (tools/load.ts), the gateway's /system/metrics,
# and the profile's summary (tools/profile_summary.ts).
#
#   tools/profile_gateway.sh hello|counters|slow
#
# GW=file.slight uses another gateway library in place of gateway.slight.
# The profile is kept in $OUT (a temporary directory unless set). Port 8080
# must be free.
cd "$(dirname "$0")/.."
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
node --cpu-prof --cpu-prof-dir="$OUT" --cpu-prof-interval 200 bin/cpi.ts ${GW:-examples/gateway/gateway.slight} examples/gateway/plain.slight > "$OUT/gateway.log" 2>&1 &
GATEWAY=$!
until curl -s -o /dev/null http://127.0.0.1:8080/system/stats; do sleep 0.1; done
H=http://127.0.0.1:8080
case "$1" in
    hello)
        for c in 1 8 32 128; do node tools/load.ts "$H/hello/x" $c 6; done ;;
    counters)
        node tools/load.ts "$H/counter/n{i}" 8 6
        echo "after: $(curl -s $H/system/stats)"
        node tools/load.ts "$H/hello/x" 8 4 ;;
    slow)
        node tools/load.ts "$H/slow" 4 8 &
        SLOW=$!
        node tools/load.ts "$H/hello/x" 8 8
        wait $SLOW ;;
esac
echo "--- gateway metrics"
curl -s $H/system/metrics | grep -v " total 0 "
curl -s -o /dev/null $H/system/quit
wait $GATEWAY
grep -E "hello [+-]1" "$OUT/gateway.log" | tail -3
node tools/profile_summary.ts "$OUT"/*.cpuprofile 20
echo "profile: $(ls "$OUT"/*.cpuprofile)"
