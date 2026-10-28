#!/usr/bin/env bash
# Publish a HardlyReader release — or refuse to.
#
# A release here is four bundles in one GitHub release: an AppImage, a Flatpak,
# an APK and an IPA. 0.6.6 went out with only the AppImage attached, because the
# sequence was manual and a step could be skipped without anything complaining.
# So this script does nothing on GitHub until all four are present and valid,
# and after publishing it reads the release back and checks all four again.
#
# Usage:
#   scripts/release.sh <version> --ipa <path>            # publish
#   scripts/release.sh <version> --ipa <path> --dry-run  # check and print only
#   scripts/release.sh <version> --ipa <path> --build    # run the builders first
#
# Other flags: --appimage, --flatpak, --apk to collect a bundle from somewhere
# other than where its builder leaves it; --notes-file to attach release notes
# instead of GitHub's generated ones; --repo to release from a fork.
#
# The IPA has no builder on Linux: codemagic.yaml builds it on a macOS worker
# and the artifact is downloaded by hand, so it is the one bundle that must be
# passed in. Run this from the checkout whose bundles you mean to publish.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="ing.hardlysleep.hardlyreader"
REPO_SLUG="${RELEASE_REPO:-hardlysleeping/HardlyReader}"

# Size floors, not the sizes to expect. Each bundle weighs about twice its floor
# (an AppImage of this app is ~80MB, the APK ~16MB, the IPA and the Flatpak
# ~3MB), so a real build passes whatever the release changes, while a truncated
# upload or a placeholder file does not.
APPIMAGE_FLOOR=$((40 * 1024 * 1024))
APK_FLOOR=$((8 * 1024 * 1024))
IPA_FLOOR=$((1024 * 1024))
FLATPAK_FLOOR=$((1024 * 1024))

# How each asset is named on the release page. The upload uses a staged copy
# with this name, because gh takes the asset name from the file name.
JQ_ASSETS='.assets[] | [.name, .state, (.size | tostring)] | @tsv'

VERSION=""
IPA=""
APPIMAGE=""
FLATPAK=""
APK=""
NOTES_FILE=""
DRY_RUN=0
BUILD=0

usage() {
  # The header comment is the help text; stop at the first line that is code.
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ipa) IPA="${2:?--ipa needs a path}"; shift 2 ;;
    --appimage) APPIMAGE="${2:?--appimage needs a path}"; shift 2 ;;
    --flatpak) FLATPAK="${2:?--flatpak needs a path}"; shift 2 ;;
    --apk) APK="${2:?--apk needs a path}"; shift 2 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a path}"; shift 2 ;;
    --repo) REPO_SLUG="${2:?--repo needs owner/name}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --build) BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)
      [ -z "$VERSION" ] || { echo "one version, not two: $1" >&2; exit 2; }
      VERSION="$1"
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <version> --ipa <path> [--dry-run] [--build]" >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must look like 0.6.8, not '$VERSION'" >&2
  exit 2
fi

TAG="v$VERSION"
APPIMAGE_ASSET="hardlyreader-$VERSION-linux-x86_64.AppImage"
FLATPAK_ASSET="hardlyreader-$VERSION-x86_64.flatpak"
APK_ASSET="hardlyreader-$VERSION-android.apk"
IPA_ASSET="hardlyreader-$VERSION-ios.ipa"

# The three Linux/Android builders, in the order they depend on each other: the
# Flatpak packs the binary the AppImage build compiles. Only the release path
# builds; --dry-run prints these instead of running them.
TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/hr-target-ubuntu}"

shell_quote() {
  case "$1" in
    ''|*[!A-Za-z0-9_./:=@%+,-]*)
      printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
      ;;
    *) printf '%s' "$1" ;;
  esac
}

show() {
  local arg
  printf '  '
  for arg in "$@"; do
    shell_quote "$arg"
    printf ' '
  done
  printf '\n'
}

run() {
  if [ "$DRY_RUN" = 1 ]; then show "$@"; else "$@"; fi
}

echo "HardlyReader $VERSION — four bundles, one release"

if [ "$BUILD" = 1 ]; then
  echo
  echo "Building:"
  run bash "$REPO_ROOT/scripts/build-appimage.sh"
  run bash "$REPO_ROOT/scripts/build-flatpak.sh" "$TARGET_DIR/release/hardlyreader"
  run bash "$REPO_ROOT/scripts/android-build.sh" --release
  # The IPA is not here: it needs macOS. codemagic.yaml builds it in CI.
fi

# Where each builder leaves its output. Any of these can be overridden by the
# matching flag above; only the APK is searched for, because the bundle name
# comes from the gradle project rather than from the version.
: "${APPIMAGE:=$TARGET_DIR/release/bundle/appimage/HardlyReader_${VERSION}_amd64.AppImage}"
: "${FLATPAK:=$REPO_ROOT/flatpak/$APP_ID-$VERSION.flatpak}"
if [ -z "$APK" ]; then
  APK="$(find "$REPO_ROOT/src-tauri/gen/android/app/build/outputs/apk" \
    -name '*-release.apk' ! -name '*unsigned*' -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | head -1 | cut -d' ' -f2- || true)"
fi

problems=()
problem() { problems+=("$1"); }

# A bundle passes when it exists, is big enough to be the real thing, and looks
# like the format it claims. Each check stops at the first thing wrong with that
# bundle, so the message names the bundle and the reason.
check_bundle() {
  local label="$1" path="$2" floor="$3" kind="$4" hint="$5" size listing magic

  if [ -z "$path" ]; then
    problem "$label: nothing to check — $hint"
    return 0
  fi
  if [ ! -e "$path" ]; then
    problem "$label: missing — $path ($hint)"
    return 0
  fi
  if [ -d "$path" ]; then
    problem "$label: a directory, not a bundle — $path"
    return 0
  fi
  if [ ! -r "$path" ]; then
    problem "$label: not readable — $path"
    return 0
  fi

  size="$(wc -c < "$path")"
  if [ "$size" -lt "$floor" ]; then
    problem "$label: $size bytes, under the $floor-byte floor — truncated or a placeholder — $path"
    return 0
  fi

  case "$kind" in
    appimage)
      # An AppImage is an ELF with the AppImage type marker at byte 8. The ELF
      # check alone would accept the bare binary, which is the wrong upload.
      magic="$(head -c 11 -- "$path" | od -An -tx1 | tr -d ' \n')"
      if [ "${magic:0:8}" != "7f454c46" ]; then
        problem "$label: not an ELF binary — $path"
      elif [ "${magic:16:6}" != "414902" ]; then
        problem "$label: an ELF binary but not an AppImage (no type-2 marker) — $path"
      fi
      ;;
    flatpak)
      # A single-file bundle starts with the literal "flatpak", then a version.
      magic="$(head -c 7 -- "$path")"
      if [ "$magic" != "flatpak" ]; then
        problem "$label: not a flatpak bundle (no bundle header) — $path"
      fi
      ;;
    apk)
      if ! listing="$(unzip -Z1 -- "$path" 2>/dev/null)"; then
        problem "$label: not a readable zip — $path"
      elif ! printf '%s\n' "$listing" | grep -qx 'AndroidManifest.xml'; then
        problem "$label: a zip without AndroidManifest.xml — not an APK — $path"
      elif ! printf '%s\n' "$listing" | grep -q '^classes.*\.dex$'; then
        problem "$label: an APK-shaped zip with no classes.dex — $path"
      fi
      ;;
    ipa)
      if ! listing="$(unzip -Z1 -- "$path" 2>/dev/null)"; then
        problem "$label: not a readable zip — $path"
      elif ! printf '%s\n' "$listing" | grep -qE '^Payload/[^/]+\.app/Info\.plist$'; then
        problem "$label: a zip without Payload/<name>.app/Info.plist — not an .ipa — $path"
      fi
      ;;
  esac
  return 0
}

check_bundle "AppImage" "$APPIMAGE" "$APPIMAGE_FLOOR" appimage \
  "build it with scripts/build-appimage.sh, or pass --appimage"
check_bundle "Flatpak" "$FLATPAK" "$FLATPAK_FLOOR" flatpak \
  "build it with scripts/build-flatpak.sh, or pass --flatpak"
check_bundle "APK" "$APK" "$APK_FLOOR" apk \
  "build and sign it with scripts/android-build.sh --release, or pass --apk"
check_bundle "IPA" "$IPA" "$IPA_FLOOR" ipa \
  "pass --ipa: it is built by codemagic.yaml on macOS and cannot be built on Linux"

# The tag is the version, so a build of a different version must not be shipped
# under this one. package.json is the version every builder reads.
PACKAGE_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  problem "version: package.json says $PACKAGE_VERSION, this release says $VERSION"
fi

if [ "$DRY_RUN" = 0 ] && [ ${#problems[@]} -eq 0 ]; then
  if ! gh auth status >/dev/null 2>&1; then
    problem "gh: not signed in — a release cannot be uploaded without it"
  fi
  if gh api "repos/$REPO_SLUG/git/ref/tags/$TAG" >/dev/null 2>&1; then
    problem "tag: $TAG already exists on $REPO_SLUG — refusing to move a published release"
  fi
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo
  echo "release refused: $TAG is not ready, and nothing was created on GitHub." >&2
  for p in "${problems[@]}"; do
    echo "  $p" >&2
  done
  echo >&2
  echo "All four bundles must exist, be the right kind of file and be the right" >&2
  echo "version before a release is created. Fix what is listed above and run again." >&2
  exit 1
fi

echo
printf '  %-9s %12s bytes  %s\n' "AppImage" "$(wc -c < "$APPIMAGE")" "$APPIMAGE"
printf '  %-9s %12s bytes  %s\n' "Flatpak" "$(wc -c < "$FLATPAK")" "$FLATPAK"
printf '  %-9s %12s bytes  %s\n' "APK" "$(wc -c < "$APK")" "$APK"
printf '  %-9s %12s bytes  %s\n' "IPA" "$(wc -c < "$IPA")" "$IPA"

# Stage the four under the names they must carry on the release page. Only the
# release path copies; a dry run leaves the tree untouched.
STAGE="$REPO_ROOT/dist/release-$TAG"
echo
echo "Staging as $STAGE:"
run mkdir -p "$STAGE"
run cp -- "$APPIMAGE" "$STAGE/$APPIMAGE_ASSET"
run cp -- "$FLATPAK" "$STAGE/$FLATPAK_ASSET"
run cp -- "$APK" "$STAGE/$APK_ASSET"
run cp -- "$IPA" "$STAGE/$IPA_ASSET"

NOTES_ARGS=(--generate-notes)
if [ -n "$NOTES_FILE" ]; then
  if [ ! -r "$NOTES_FILE" ]; then
    echo "notes file not readable: $NOTES_FILE" >&2
    exit 1
  fi
  NOTES_ARGS=(--notes-file "$NOTES_FILE")
fi

# Reads a release back and asserts each of the four names is attached, uploaded
# and non-empty. Called once on the draft and once on the published release.
verify_assets() {
  local endpoint="$1" label="$2" rows asset row state size bad=0
  if ! rows="$(gh api "repos/$REPO_SLUG/releases/$endpoint" --jq "$JQ_ASSETS")"; then
    echo "could not read $label back from GitHub" >&2
    return 1
  fi
  for asset in "$APPIMAGE_ASSET" "$FLATPAK_ASSET" "$APK_ASSET" "$IPA_ASSET"; do
    row="$(printf '%s\n' "$rows" | awk -F '\t' -v name="$asset" '$1 == name' | head -1)"
    if [ -z "$row" ]; then
      echo "  $label: $asset is not attached" >&2
      bad=1
      continue
    fi
    state="$(printf '%s' "$row" | cut -f2)"
    size="$(printf '%s' "$row" | cut -f3)"
    if [ "$state" != "uploaded" ]; then
      echo "  $label: $asset is $state, not uploaded" >&2
      bad=1
    elif [ -z "$size" ] || [ "$size" -le 0 ]; then
      echo "  $label: $asset is uploaded with no bytes" >&2
      bad=1
    fi
  done
  return "$bad"
}

# The id of the draft for this tag, or nothing. A run that stopped after the
# draft was created — a failed upload, a failed read-back, a Ctrl-C — leaves
# that draft behind, and the bundles it did not get are still valid, so a retry
# finishes it instead of dying on "release already exists". The id, not the tag,
# is what the read-back uses: a draft has no resolvable `releases/tags/` path.
draft_id() {
  gh api "repos/$REPO_SLUG/releases?per_page=100" \
    --jq ".[] | select(.draft and .tag_name == \"$TAG\") | .id" 2>/dev/null \
    | head -1 || true
}

echo
echo "Release steps:"
if [ "$DRY_RUN" = 1 ]; then
  echo "  # a draft for $TAG that already exists is reused: nothing is created, and"
  echo "  # every bundle goes up again with --clobber before the read-back proves it"
  echo "  # with no draft, the tag must not exist yet; this read is expected to fail with 404"
  show gh api "repos/$REPO_SLUG/git/ref/tags/$TAG"
  echo "  # only when there is no draft for $TAG yet:"
  run gh release create "$TAG" --repo "$REPO_SLUG" --draft \
    --title "HardlyReader $VERSION" "${NOTES_ARGS[@]}"
  run gh release upload "$TAG" --repo "$REPO_SLUG" --clobber \
    "$STAGE/$APPIMAGE_ASSET" "$STAGE/$FLATPAK_ASSET" "$STAGE/$APK_ASSET" "$STAGE/$IPA_ASSET"
  echo "  # before publishing: read the draft back by its id and assert all four"
  show gh api "repos/$REPO_SLUG/releases/<draft-id>" --jq "$JQ_ASSETS"
  run gh release edit "$TAG" --repo "$REPO_SLUG" --draft=false --latest
  echo "  # after publishing: read it back by tag and assert all four again"
  show gh api "repos/$REPO_SLUG/releases/tags/$TAG" --jq "$JQ_ASSETS"
  echo
  echo "dry run: nothing was created, uploaded, published or tagged."
  exit 0
fi

# A draft first: assets go up while the release is invisible, and it is only
# published once all four have been read back. An existing draft is reused, so
# this step is skippable by a retry but never creatable twice.
draft="$(draft_id)"
if [ -n "$draft" ]; then
  echo "  draft #$draft for $TAG already exists — reusing it, nothing new is created"
else
  echo "  creating a draft release for $TAG"
  if ! gh release create "$TAG" --repo "$REPO_SLUG" --draft \
    --title "HardlyReader $VERSION" "${NOTES_ARGS[@]}"; then
    echo "could not create a draft for $TAG; nothing was uploaded" >&2
    exit 1
  fi
  draft="$(draft_id)"
  if [ -z "$draft" ]; then
    echo "no draft release for $TAG after creating it — not uploading" >&2
    exit 1
  fi
  echo "  draft #$draft created"
fi

# --clobber is what makes the retry possible: whatever already sits on the draft
# is replaced by these four, so a half-uploaded draft is finished rather than
# refused for having an asset of the same name.
if ! gh release upload "$TAG" --repo "$REPO_SLUG" --clobber \
  "$STAGE/$APPIMAGE_ASSET" "$STAGE/$FLATPAK_ASSET" "$STAGE/$APK_ASSET" "$STAGE/$IPA_ASSET"; then
  echo "the upload failed; $TAG is still a draft — fix what failed and run this" >&2
  echo "again: the draft is reused and the bundles are re-uploaded over it" >&2
  exit 1
fi

echo
echo "Checking the draft before publishing:"
if ! verify_assets "$draft" "draft $TAG"; then
  echo "the draft for $TAG is not whole, so it was not published; it is still a" >&2
  echo "draft, so fix the bundle and run this again to reuse it" >&2
  exit 1
fi

if ! gh release edit "$TAG" --repo "$REPO_SLUG" --draft=false --latest; then
  echo "could not publish $TAG; it is still a draft — run this again to reuse it" >&2
  exit 1
fi

echo
echo "Published. Reading it back:"
if ! verify_assets "tags/$TAG" "$TAG"; then
  echo "$TAG is public but not whole — attach the missing bundles or delete it" >&2
  exit 1
fi
echo "$TAG: all four bundles are uploaded and downloadable"
