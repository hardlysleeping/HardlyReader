#!/bin/bash
# Put this release's Linux builds where they are run from.
#
# The iPAs live in one folder with one name each, so installing one is
# "/home/bazzite/IPA/HardlyReader-unsigned.ipa" and nothing else. The desktop
# builds had no such home: the bundles landed in the build tree
# (/tmp/hr-target-ubuntu/...) and in flatpak/, and finding "the current one"
# meant reading version numbers out of four filenames. So: one folder, one name
# per format, overwritten by every build.
#
#   ~/AppImages/hardlyreader.appimage   the Linux desktop app, executable
#   ~/Flatpaks/hardlyreader.flatpak     the same build, packaged for flatpak
#
# Both come out of the same Ubuntu-built binary, so they are the same app; the
# flatpak is there for the sandbox and the desktop entry, the AppImage for
# double-clicking without installing anything.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['version'])")"
APPIMAGE_DIR="$HOME/AppImages"
FLATPAK_DIR="$HOME/Flatpaks"
APPIMAGE_NAME="hardlyreader.appimage"
FLATPAK_NAME="hardlyreader.flatpak"

# The AppImage the build just made; a path may be passed instead.
APPIMAGE_SRC="${1:-/tmp/hr-target-ubuntu/release/bundle/appimage/HardlyReader_${VERSION}_amd64.AppImage}"
FLATPAK_SRC="${2:-$REPO/flatpak/ing.hardlysleep.hardlyreader-$VERSION.flatpak}"

[ -f "$APPIMAGE_SRC" ] || { echo "publish-local: no AppImage at $APPIMAGE_SRC" >&2; exit 1; }
[ -f "$FLATPAK_SRC" ] || { echo "publish-local: no flatpak at $FLATPAK_SRC" >&2; exit 1; }

mkdir -p "$APPIMAGE_DIR" "$FLATPAK_DIR"
cp -f "$APPIMAGE_SRC" "$APPIMAGE_DIR/$APPIMAGE_NAME"
cp -f "$FLATPAK_SRC" "$FLATPAK_DIR/$FLATPAK_NAME"
# An AppImage that is not executable is a 98MB file, not an app.
chmod 755 "$APPIMAGE_DIR/$APPIMAGE_NAME"

echo "published $VERSION"
ls -l "$APPIMAGE_DIR/$APPIMAGE_NAME" "$FLATPAK_DIR/$FLATPAK_NAME" | awk '{print "  " $5 "\t" $NF}'
