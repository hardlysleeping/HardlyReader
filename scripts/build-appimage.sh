#!/usr/bin/env bash
# Build a portable AppImage: an old glibc is the whole point, so this runs in a
# container whose glibc is older than any target (Ubuntu 22.04, glibc 2.35).
set -euo pipefail

cd /home/bazzite/apps/hardlyread

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf fakeroot >/dev/null

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v pnpm >/dev/null 2>&1; then
  sudo corepack enable
  corepack prepare pnpm@latest --activate
fi

export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

pnpm install --frozen-lockfile

# A target dir of its own: the host's Arch build lives in src-tauri/target and
# the two toolchains must not share fingerprints.
export CARGO_TARGET_DIR=/tmp/hr-target-ubuntu
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=1

pnpm tauri build --bundles appimage
