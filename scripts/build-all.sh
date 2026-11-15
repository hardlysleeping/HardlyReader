#!/bin/bash
# One call for a Linux build of this tree: the Ubuntu binary, the AppImage, and
# the flatpak -- published to ~/AppImages and ~/Flatpaks.
#
#   bash scripts/build-all.sh
#
# Run it as the desktop user (not root). Two things this script knows that cost a
# run each to learn:
#
#   * `distrobox enter` needs the desktop session's bus, or podman's polkit check
#     refuses to start the container ("requires interactive authentication"),
#     which reads like a permission problem with the repo.
#   * the container carries pnpm 9 while the host has a newer one, so a
#     node_modules written by a host `pnpm build` makes the container want to
#     purge and reinstall it -- which it asks about, and a non-interactive run
#     then sits on the question for ever. CI=true answers it -- not CI=1,
#     which the tauri CLI reads as an invalid value for --ci.
#
# The frontend is built by `tauri build` inside the container, so this produces
# the desktop artifacts only. The PWA is a separate, cheap step on the host:
#   pnpm build && python3 scripts/serve-pwa.py --port 4179
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${HRBUILD_CONTAINER:-hrbuild}"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['version'])")"
TARGET_DIR=/tmp/hr-target-ubuntu
BINARY="$TARGET_DIR/release/hardlyreader"
APPIMAGE="$TARGET_DIR/release/bundle/appimage/HardlyReader_${VERSION}_amd64.AppImage"

cd "$REPO"

echo "== appimage, in $CONTAINER (version $VERSION) =="
# A non-interactive shell has no session bus; supply the desktop user's.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
# The container mounts $HOME, so the repo is at the same relative path inside it.
REL="${REPO#"$HOME"/}"
distrobox enter --no-tty "$CONTAINER" -- \
  bash -lc "cd \"\$HOME/$REL\" && CI=true bash scripts/build-appimage.sh"

[ -x "$BINARY" ] || { echo "build-all: no binary at $BINARY" >&2; exit 1; }
[ -f "$APPIMAGE" ] || { echo "build-all: no AppImage at $APPIMAGE" >&2; exit 1; }

echo "== flatpak, then publish both =="
bash scripts/build-flatpak.sh "$BINARY"

echo
echo "built $VERSION from $(git rev-parse --short HEAD)"
ls -l "$HOME/AppImages/hardlyreader.appimage" "$HOME/Flatpaks/hardlyreader.flatpak"
