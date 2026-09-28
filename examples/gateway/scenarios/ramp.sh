#!/usr/bin/env bash
# Load that climbs and falls, 3 seconds at each step: how closely does the
# pool follow it, and where does the time go as it climbs?
. "$(dirname "$0")/lib.sh"
wait_for_gateway
for r in 5 10 20 40 80 160 80 40 20 10 5; do
    rate "$r" 3 '/hello/r{i}'
    report "ramp: $r/s for 3 s"
done
