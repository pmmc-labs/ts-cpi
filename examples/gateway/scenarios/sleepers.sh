#!/usr/bin/env bash
# Visit 30 counters, let them fall asleep, visit them again: the second
# visit pays for waking each one.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
fire 30 30 '/counter/s{i}'
report "sleepers: first visit (creates them)"
fire 30 30 '/counter/s{i}'
report "sleepers: second visit (awake)"
sleep 4
echo "after 4 idle seconds: $(curl -s "$BASE/system/stats")"
fire 30 30 '/counter/s{i}'
report "sleepers: third visit (wakes them)"
