#!/usr/bin/env bash
# trim.sh <raw log> > fixture : the lines land.sh's verdict functions read, plus 3 noise lines naming repo paths
set -euo pipefail
f=$1
a=$(grep -n '✖ failing tests:' "$f" | head -1 | cut -d: -f1 || true)
if [ -z "$a" ]; then cut -c1-400 "$f"; exit; fi
{ head -n $((a-1)) "$f" | grep -nE "run-tests:|Interrupted while running|exit code 137|burn-in:|The tests left|ran past|were killed|✖" || true
  head -n $((a-1)) "$f" | grep -nE "(^|[^/A-Za-z0-9_.-])src/[A-Za-z0-9_./-]+\.ts:[0-9]+" | grep -vE "run-tests:|✖" | head -3 || true
} | sort -n -t: -k1,1 -u | cut -d: -f2-
tail -n +"$a" "$f" | cut -c1-1000
