#!/usr/bin/env bash
# A steady, light load: 10 hello requests a second for 15 seconds. The
# baseline the other scenarios are read against.
. "$(dirname "$0")/lib.sh"
wait_for_gateway
rate 10 15 '/hello/t{i}'
report "trickle: 10/s for 15 s"
