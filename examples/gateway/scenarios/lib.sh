# Shared by the gateway scenarios: sending requests with curl, and reporting
# what the clients saw beside what the gateway saw. Source it; don't run it.
#
# Each request's result is one "status seconds" line in $RESULTS; `report`
# summarizes and clears them. Status 000 means curl could not connect.

BASE="${BASE:-http://127.0.0.1:8080}"
WORK="$(mktemp -d)"
RESULTS="$WORK/results"
: > "$RESULTS"
trap 'rm -rf "$WORK"; kill $(jobs -p) 2>/dev/null' EXIT

now() {
    perl -MTime::HiRes=time -e 'printf "%.3f\n", time'
}

# fire N PARALLEL PATH ...
# Sends N requests, at most PARALLEL at a time, cycling through the PATHs.
# "{i}" in a path becomes the request's number, so each can use a new name.
fire() {
    local n=$1 parallel=$2
    shift 2
    local count=$# cfg="$WORK/fire.$$.$RANDOM" i=0
    : > "$cfg"
    while [ $i -lt "$n" ]; do
        local k=$(( i % count + 1 ))
        local path="${!k}"
        printf 'url = "%s%s"\noutput = "/dev/null"\n' "$BASE" "${path//\{i\}/$i}" >> "$cfg"
        i=$(( i + 1 ))
    done
    curl --parallel --parallel-immediate --parallel-max "$parallel" -s -K "$cfg" \
        -w '%{http_code} %{time_total}\n' >> "$RESULTS"
    rm -f "$cfg"
}

# rate PER-SECOND SECONDS PATH ...
# About PER-SECOND requests a second for SECONDS seconds: each second's
# requests are sent together, then it sleeps out the rest of the second.
rate() {
    local per=$1 seconds=$2
    shift 2
    local s=0
    while [ $s -lt "$seconds" ]; do
        local t0
        t0=$(now)
        fire "$per" "$per" "$@"
        perl -MTime::HiRes=time,sleep -e "my \$left = 1 - (time - $t0); sleep(\$left) if \$left > 0"
        s=$(( s + 1 ))
    done
}

# report TITLE
# Status counts and latency percentiles from the clients' side, then the
# gateway's own metrics. Clears the results.
report() {
    echo "== $1"
    awk '{ n++; c[$1]++ } END { printf "clients: %d requests,", n; for (k in c) printf " %s x%d", k, c[k]; print "" }' "$RESULTS"
    sort -n -k2 "$RESULTS" | awk '
        function at(q,   i) { i = int(NR * q); if (i < NR * q) i++; if (i < 1) i = 1; return t[i] * 1000 }
        { t[NR] = $2 }
        END { if (NR) printf "clients: latency ms p50 %.1f  p95 %.1f  p99 %.1f  max %.1f\n", at(0.5), at(0.95), at(0.99), t[NR] * 1000 }'
    echo "gateway:"
    curl -s "$BASE/system/metrics" | sed 's/^/  /'
    echo
    : > "$RESULTS"
}

# Waits until the gateway answers, for up to 10 seconds.
wait_for_gateway() {
    local i=0
    until curl -s -o /dev/null "$BASE/system/stats"; do
        i=$(( i + 1 ))
        [ $i -gt 100 ] && { echo "no gateway at $BASE" >&2; exit 1; }
        sleep 0.1
    done
}
