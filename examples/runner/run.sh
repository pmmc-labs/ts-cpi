#!/bin/sh
# Loads the runner's library, every engine, and a program.
#   examples/runner/run.sh              the runner (needs a terminal)
#   examples/runner/run.sh check        checks every engine against the reference
set -e
cd "$(dirname "$0")/../.."
program=examples/runner/${1:-runner}.slight
exec node bin/cpi.ts examples/life/lib/lists.slight examples/runner/lib/board.slight \
    examples/runner/engines/*.slight examples/runner/engines.slight "$program"
