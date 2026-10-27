#!/bin/sh
# Prints each section of a Markdown doc with its line range and size, so a session can read
# only the sections it needs (Read with offset and limit) instead of the whole doc.
#   tools/doc-map.sh docs/subagents.md
# A section runs from its heading to the next heading of any level; headings inside code
# fences don't count.
set -eu
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: tools/doc-map.sh <doc.md>" >&2; exit 2; }

awk '
  function flush(end) { if (name != "") printf "%5d-%-5d %6.1f KB  %s\n", start, end, bytes / 1024, name }
  /^```/ { fence = !fence }
  !fence && /^#{1,4} / { flush(NR - 1); name = $0; start = NR; bytes = 0 }
  { bytes += length($0) + 1 }
  END { flush(NR); printf "%5s %-5s %6.1f KB  total\n", "", "", total / 1024 }
  { total += length($0) + 1 }
' "$1"
