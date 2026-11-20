#!/usr/bin/env bash
# The only thing the desktop's backup key can run (#252). Its authorized_keys line forces this command,
# so the key can list $DATA_DIR/offbox and fetch a file from it, and nothing else:
#   list        prints SHA256SUMS
#   get <name>  writes that backup to stdout
set -euo pipefail

OUT=${DATA_DIR:-$HOME/.local/share/claude-coordinator}/offbox
read -r cmd name extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
names='^(coordinator-[0-9]{4}-[0-9]{2}-[0-9]{2}|coordinator-weekly-[0-9]{4}-W[0-9]{2}|state-[0-9]{4}-[0-9]{2}-[0-9]{2})\.db$'
# An app's nightly backup (#828): apps/<contraption>/<day>/<file>, one plain name per part, no `..` anywhere.
app_names='^apps/[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?/[0-9]{4}-[0-9]{2}-[0-9]{2}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'
# An Android app's release key or its password file (#837): keys/<contraption>-release.jks or .pass.
key_names='^keys/[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?-release\.(jks|pass)$'

case ${cmd:-} in
  list) touch -- "$OUT/.pulled" 2>/dev/null || true; exec cat -- "$OUT/SHA256SUMS" ;; # the desktop's pull starts with a list: Status reads this file's time (#1142)
  get)
    if [[ -z ${extra:-} && (${name:-} =~ $names || ${name:-} =~ $key_names || (${name:-} =~ $app_names && $name != *..*)) && -f $OUT/$name && ! -L $OUT/$name ]]; then exec cat -- "$OUT/$name"; fi
    echo "No such backup: ${name:-}" >&2
    exit 2
    ;;
  *)
    echo "Usage: list | get <name>" >&2
    exit 2
    ;;
esac
