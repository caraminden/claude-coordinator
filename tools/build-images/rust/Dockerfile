# citadel-build-rust (H1, specs/heavy-jobs-across-machines.md section 3): rustup and the stable toolchain for a heavy
# Rust build on a lent machine. Where a job mounts the cache volume citadel-cargo (the crates and the toolchains a
# project's rust-toolchain.toml names) is its recipe's (H2). Built by .github/workflows/build-images.yml.
FROM docker.io/library/rust:1-slim-bookworm
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends ca-certificates git pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source=https://github.com/caraminden/claude-coordinator \
      org.opencontainers.image.description="Citadel's Rust build image: rustup and stable Rust"
WORKDIR /work
