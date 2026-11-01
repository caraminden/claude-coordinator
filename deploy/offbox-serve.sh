#!/usr/bin/env bash
# The only thing the desktop's backup key can run (#252). Its authorized_keys line forces this command,
# so the key can list $DATA_DIR/offbox and fetch a file from it, and nothing else:
#   list        prints SHA256SUMS
#   get <name>  writes that backup to stdout
set -euo pipefail

OUT=${DATA_DIR:-$HOME/.local/share/claude-coordinator}/offbox
read -r cmd name extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
names='^(coordinator-[0-9]{4}-[0-9]{2}-[0-9]{2}|coordinator-weekly-[0-9]{4}-W[0-9]{2}|state-[0-9]{4}-[0-9]{2}-[0-9]{2})\.db$'

case ${cmd:-} in
  list) exec cat -- "$OUT/SHA256SUMS" ;;
  get)
    if [[ -z ${extra:-} && ${name:-} =~ $names && -f $OUT/$name ]]; then exec cat -- "$OUT/$name"; fi
    echo "No such backup: ${name:-}" >&2
    exit 2
    ;;
  *)
    echo "Usage: list | get <name>" >&2
    exit 2
    ;;
esac
