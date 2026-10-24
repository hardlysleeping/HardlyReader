#!/usr/bin/env bash
# Build a debug Android APK for HardlyReader (and gate the release path).
#
# Idempotent: installs the NDK / SDK platform / android rust targets / the
# gen/android project only when missing, applies the BuildTask.kt fix described
# in docs/android.md, then builds. All heavy lifting happens inside the Arch
# distrobox because the host has no pnpm/cargo toolchain.
#
# Usage:
#   scripts/android-build.sh              # debug APK, arm64-v8a + armeabi-v7a
#   TARGETS="aarch64" scripts/android-build.sh
#   scripts/android-build.sh --release    # needs signing env, see docs/android.md
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${ANDROID_BUILD_LOG:-$HOME/.hermes/cache/scratch/android-build.log}"

JAVA_HOME="${JAVA_HOME:-$HOME/.local/java/jdk-17.0.20.1+1}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
NDK_VERSION="${NDK_VERSION:-27.2.12479018}"
NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VERSION}"
# ABIs worth shipping to a tablet; override e.g. TARGETS="aarch64 armv7 x86_64 i686".
TARGETS="${TARGETS:-aarch64 armv7}"

MODE="debug"
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --release) MODE="release" ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

export JAVA_HOME ANDROID_HOME NDK_HOME REPO_ROOT TARGETS MODE
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.cargo/bin:$PATH"

echo "==> JAVA_HOME=$JAVA_HOME"
echo "==> ANDROID_HOME=$ANDROID_HOME"
echo "==> NDK_HOME=$NDK_HOME"
echo "==> profile=$MODE targets=$TARGETS"

# --- 1. host-side prerequisites (sdkmanager/rustup work outside the box) ---
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "ERROR: sdkmanager not found under $ANDROID_HOME/cmdline-tools/latest/bin" >&2
  exit 1
fi

if [ ! -d "$NDK_HOME" ]; then
  echo "==> installing NDK $NDK_VERSION"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "ndk;$NDK_VERSION" "platform-tools" >/dev/null
fi

# The generated project pins compileSdk/targetSdk to whatever the CLI template
# used (37 today), so make sure that platform is present.
if [ ! -d "$ANDROID_HOME/platforms/android-37.0" ] && [ ! -d "$ANDROID_HOME/platforms/android-37" ]; then
  echo "==> installing SDK platform 37 + build-tools 37.0.0"
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "platforms;android-37.0" "build-tools;37.0.0" >/dev/null
fi

# --- 2. everything else inside the Arch distrobox ---
# shellcheck disable=SC2016
DISTRO_CMD='
set -euo pipefail
cd "$REPO_ROOT"
export JAVA_HOME ANDROID_HOME NDK_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$HOME/.cargo/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "ERROR: rustup missing in the distrobox; install it with:" >&2
  echo "  curl https://sh.rustup.rs -sSf | sh -s -- -y --no-modify-path" >&2
  exit 1
fi
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

if [ ! -d src-tauri/gen/android ]; then
  echo "==> generating src-tauri/gen/android"
  ./node_modules/.bin/tauri android init --ci --skip-targets-install
fi

# --- template gap fix (see docs/android.md) ---------------------------------
# The generated gradle buildSrc task runs `node tauri android android-studio-script`
# with cwd=src-tauri, so node resolves "tauri" as a file path and dies with
# MODULE_NOT_FOUND. Point it at the CLI entry that actually exists.
CLI_JS="$REPO_ROOT/node_modules/@tauri-apps/cli/tauri.js"
PATCHED=0
while IFS= read -r task_kt; do
  [ -n "$task_kt" ] || continue
  if grep -q "listOf(\"tauri\", \"android\", \"android-studio-script\")" "$task_kt"; then
    sed -i "s|listOf(\"tauri\", \"android\", \"android-studio-script\")|listOf(\"$CLI_JS\", \"android\", \"android-studio-script\")|" "$task_kt"
    echo "==> patched gradle rust task: $task_kt"
    PATCHED=1
  fi
done < <(find src-tauri/gen/android/buildSrc -name BuildTask.kt 2>/dev/null)

if [ "$PATCHED" = "1" ]; then
  # force buildSrc recompilation + config cache invalidation
  rm -rf src-tauri/gen/android/buildSrc/build src-tauri/gen/android/.gradle/configuration-cache
fi
# ---------------------------------------------------------------------------

TARGET_FLAGS=()
for t in $TARGETS; do TARGET_FLAGS+=(--target "$t"); done

if [ "$MODE" = "release" ]; then
  : "${ANDROID_KEYSTORE_PATH:?release build needs ANDROID_KEYSTORE_PATH (keep the keystore outside the repo)}"
  : "${ANDROID_KEYSTORE_ALIAS:?release build needs ANDROID_KEYSTORE_ALIAS}"
  : "${ANDROID_KEYSTORE_PASSWORD:?release build needs ANDROID_KEYSTORE_PASSWORD}"
  [ -f "$ANDROID_KEYSTORE_PATH" ] || { echo "keystore not found: $ANDROID_KEYSTORE_PATH" >&2; exit 1; }
  ./node_modules/.bin/tauri android build --apk "${TARGET_FLAGS[@]}" "${EXTRA_ARGS[@]}"

  # ---------------------------------------------------------------------
  # Sign it ourselves. Gradle produces `*-release-unsigned.apk` because the
  # generated project has no release signingConfig, and patching generated
  # Kotlin DSL is fragile — zipalign + apksigner is two commands, is what the
  # Play/Codemagic pipelines do anyway, and cannot be lost to a re-init.
  # The password is passed by env NAME, never as an argv value.
  # ---------------------------------------------------------------------
  BT=$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)
  [ -x "$BT/apksigner" ] || { echo "no apksigner in $BT" >&2; exit 1; }
  UNSIGNED=$(find src-tauri/gen/android/app/build/outputs/apk -name "*-release-unsigned.apk" | head -1)
  [ -n "$UNSIGNED" ] || { echo "no unsigned release APK to sign" >&2; exit 1; }
  SIGNED="${UNSIGNED%-unsigned.apk}.apk"
  "$BT/zipalign" -p -f 4 "$UNSIGNED" "$SIGNED.aligned"
  ANDROID_KEYSTORE_PASSWORD="$ANDROID_KEYSTORE_PASSWORD" "$BT/apksigner" sign \
    --ks "$ANDROID_KEYSTORE_PATH" --ks-key-alias "$ANDROID_KEYSTORE_ALIAS" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEYSTORE_PASSWORD \
    --out "$SIGNED" "$SIGNED.aligned"
  rm -f "$SIGNED.aligned"
  echo "==> signed: $SIGNED ($(stat -c%s "$SIGNED") bytes)"
  "$BT/apksigner" verify --print-certs "$SIGNED" | head -4
else
  ./node_modules/.bin/tauri android build --apk --debug "${TARGET_FLAGS[@]}" "${EXTRA_ARGS[@]}"
fi

echo
echo "==> APKs:"
find src-tauri/gen/android/app/build/outputs/apk -name "*.apk" -printf "%p  %s bytes\n" 2>/dev/null || true
'

echo "==> building in distrobox Arch (log: $LOG)"
mkdir -p "$(dirname "$LOG")"
set +e
distrobox enter Arch -- bash -lc "$DISTRO_CMD" 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
set -e
echo "==> exit=$rc"
exit "$rc"
