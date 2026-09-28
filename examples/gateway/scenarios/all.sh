#!/usr/bin/env bash
# Every scenario in turn, against a gateway already running.
cd "$(dirname "$0")"
for s in trickle burst ramp fanout sleepers overload slow; do
    ./$s.sh
done
