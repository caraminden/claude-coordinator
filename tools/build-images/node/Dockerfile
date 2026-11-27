# citadel-build-node (H1, specs/heavy-jobs-across-machines.md section 3): Node 24 and npm for a heavy Node build on a
# lent machine, npm's cache on the volume citadel-npm at /cache/npm. Built by .github/workflows/build-images.yml.
FROM docker.io/library/node:24-bookworm-slim
ENV npm_config_cache=/cache/npm
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source=https://github.com/caraminden/claude-coordinator \
      org.opencontainers.image.description="Citadel's Node build image: Node 24 and npm"
WORKDIR /work
