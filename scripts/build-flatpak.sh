#!/bin/bash
# Package the Ubuntu-built binary as a Flatpak.
#
# The binary has to come from the same place the AppImage does: built in Ubuntu
# 22.04, whose glibc is older than the runtime's, so it links inside
# org.gnome.Platform rather than needing a newer glibc than the runtime has.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="${1:-/tmp/hr-target-ubuntu/release/hardlyreader}"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['version'])")"
APP_ID="ing.hardlysleep.hardlyreader"
STAGE="$REPO/flatpak/stage"
BUILD="$REPO/flatpak/build"
OUT="$REPO/flatpak/$APP_ID-$VERSION.flatpak"

[ -x "$BINARY" ] || { echo "no binary at $BINARY (build it in hrbuild first)"; exit 1; }

# A release binary from plain `cargo build --release` carries NO frontend. The
# assets are embedded only when the `custom-protocol` feature is on, which the
# `tauri build` CLI passes for you. Such a binary packages cleanly, produces a
# window with nothing in it, and — because its content never changes — looks
# like a successful rebuild every time (flatpak-builder writes ~1.5 kB and says
# nothing). Refuse it here rather than shipping a blank app.
if ! grep -aq "assets/" "$BINARY"; then
  echo "refusing $BINARY: no embedded frontend — it was built without the feature." >&2
  echo "  rebuild with: cargo build --release --features tauri/custom-protocol" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$BINARY" "$STAGE/hardlyreader"
cp "$REPO/flatpak/$APP_ID.desktop" "$STAGE/"
cp "$REPO/flatpak/$APP_ID.metainfo.xml" "$STAGE/"
cp "$REPO/src-tauri/icons/128x128@2x.png" "$STAGE/icon.png"
# The manifest's `path:` sources resolve beside the manifest, so it moves in too.
cp "$REPO/flatpak/$APP_ID.yml" "$STAGE/"

echo "building $APP_ID $VERSION from $BINARY"
rm -rf "$BUILD"
flatpak run --command=flatpak-builder org.flatpak.Builder \
  --force-clean --disable-rofiles-fuse \
  --repo="$REPO/flatpak/repo" \
  "$BUILD" "$STAGE/$APP_ID.yml"

flatpak build-bundle "$REPO/flatpak/repo" "$OUT" "$APP_ID" \
  --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

echo "wrote $OUT"
