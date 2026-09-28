#!/usr/bin/env bash
# Slow requests beside fast ones: 6 /slow requests (about half a second of
# ticks each) while hello runs at 20 a second. Each process gets a quota of
# ticks per turn, so hello should stay fast while slow requests queue.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
SLOW="$WORK/slow"
( RESULTS="$SLOW"; fire 6 6 '/slow' ) &
rate 20 6 '/hello/f{i}'
wait
report "slow: hello at 20/s beside 6 slow requests (hello only)"
RESULTS_ALL="$RESULTS"; RESULTS="$SLOW"
report "slow: the 6 slow requests"
RESULTS="$RESULTS_ALL"
