#!/usr/bin/env bash
# A spike: 300 hello requests at once, 100 at a time, then quiet. The pool
# should grow while the queue is long, and shrink into cold storage after.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
fire 300 100 '/hello/b{i}'
report "burst: 300 at once"
sleep 5
echo "after 5 quiet seconds: $(curl -s "$BASE/system/stats")"
