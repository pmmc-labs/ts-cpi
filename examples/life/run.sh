#!/bin/sh
# Runs one Game of Life version with the shared library and any files named
# in its `; load:` header lines.
#   examples/life/run.sh examples/life/01-reference.slight
set -e
cd "$(dirname "$0")/../.."
version="$1"
# A version marked `; clock: virtual` depends on exact virtual time, which
# only tests can select. It would print wrong boards here, so refuse.
if grep -q '^; clock: virtual$' "$version"; then
    echo "$(basename "$version") runs only under the test clock:" >&2
    echo "    node --test --test-name-pattern $(basename "$version" | cut -c1-3) tests/life.test.ts" >&2
    exit 2
fi
extra=$(sed -n 's/^; load: //p' "$version")
exec node bin/cpi.ts examples/life/lib/lists.slight examples/life/lib/life.slight $extra "$version"
