#!/bin/sh
# Runs one Game of Life version with the shared library and any files named
# in its `; load:` header lines.
#   examples/life/run.sh examples/life/01-reference.slight
set -e
cd "$(dirname "$0")/../.."
version="$1"
extra=$(sed -n 's/^; load: //p' "$version")
exec node bin/cpi.ts examples/life/lib/lists.slight examples/life/lib/life.slight $extra "$version"
