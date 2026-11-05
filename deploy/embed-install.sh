#!/bin/bash
# Install semantic memory's embedding service (#331) for this account: llama.cpp's CPU build and
# Qwen3-Embedding-0.6B (Apache-2.0) into ~/.local/share/citadel-embed, checked against pinned hashes,
# then the user unit. Run it by hand from the live checkout: bash ~/claude-coordinator/deploy/embed-install.sh
set -euo pipefail
DIR=$HOME/.local/share/citadel-embed
LLAMA=b12125
LLAMA_SHA=d23ae67c28cdae4b1fa5a4687442c787d0ef0e89d93512056e353b10495251ae
MODEL=Qwen3-Embedding-0.6B-Q8_0.gguf
MODEL_SHA=06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
mkdir -p "$DIR"
cd "$DIR"
if [ ! -x llama/llama-server ]; then
  curl -fL -o llama.tgz "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-x64.tar.gz"
  echo "$LLAMA_SHA  llama.tgz" | sha256sum -c -
  rm -rf llama "llama-$LLAMA" && tar -xzf llama.tgz && mv "llama-$LLAMA" llama && rm llama.tgz
fi
if [ ! -f "$MODEL" ]; then
  curl -fL -o "$MODEL.part" "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/$MODEL"
  echo "$MODEL_SHA  $MODEL.part" | sha256sum -c -
  mv "$MODEL.part" "$MODEL"
fi
ln -sf "$(dirname "$(readlink -f "$0")")/citadel-embed.service" ~/.config/systemd/user/citadel-embed.service
systemctl --user daemon-reload
systemctl --user enable --now citadel-embed
sleep 5
curl -fsS http://127.0.0.1:21434/health && echo " citadel-embed is up"
