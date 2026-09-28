#!/usr/bin/env bash
# 200 requests for 100 new counter names, 20 at a time: every name makes a
# process, a mailbox and a round trip through the CPI.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
fire 200 20 '/counter/n{i}' '/counter/n{i}'
report "fanout: 100 new counters, twice each"
echo "names now: $(curl -s "$BASE/counter" | wc -w | tr -d ' ')"
