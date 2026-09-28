#!/usr/bin/env bash
# More than the gateway can hold: 2000 hello requests, 250 at a time. Queues
# hold 100, so the host answers 503 when they are full.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
fire 2000 250 '/hello/o{i}'
report "overload: 2000, 250 at a time"
