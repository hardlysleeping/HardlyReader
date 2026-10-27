#!/usr/bin/env bash
# Runs the Swift checks for the local background refresh.
#
# They are ordinary Swift — no iOS, no simulator, no Mac — so they run anywhere a
# Swift toolchain and libsqlite3 are installed:
#
#   scripts/ios-refresh-checks.sh                 # with swiftc on PATH
#   SWIFTC=/opt/swift/usr/bin/swiftc scripts/ios-refresh-checks.sh
#
# Everything except the BGTaskScheduler glue is compiled and driven here: the
# due-time arithmetic, the feed scanner, the SQLite writes and one full wake
# against a fake transport. What cannot be checked this way is iOS's half — that
# the task is registered, launched and completed — which is what the Codemagic
# IPA and its log lines are for.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
swiftc_bin=${SWIFTC:-swiftc}

if ! command -v "$swiftc_bin" >/dev/null 2>&1; then
  echo "ios-refresh-checks: no swiftc (set SWIFTC=/path/to/swiftc)" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Apple's SDK ships a SQLite3 module; the Linux toolchain does not, so one is
# shimmed here rather than in the source. Same header, same library, same
# declarations — only the module map is local to this check.
module_flags=()
printf 'import SQLite3\n' > "$work/probe.swift"
if ! "$swiftc_bin" -typecheck "$work/probe.swift" >/dev/null 2>&1; then
  header=$(ls /usr/include/sqlite3.h 2>/dev/null || true)
  if [ -z "$header" ]; then
    echo "ios-refresh-checks: no SQLite3 module and no /usr/include/sqlite3.h (install libsqlite3-dev)" >&2
    exit 1
  fi
  mkdir -p "$work/modules/SQLite3"
  cat > "$work/modules/SQLite3/module.modulemap" <<MODULEMAP
module SQLite3 [system] {
    header "$header"
    link "sqlite3"
    export *
}
MODULEMAP
  module_flags=(-I "$work/modules")
fi

echo "ios-refresh-checks: $(command -v "$swiftc_bin") — $( "$swiftc_bin" --version | head -1)"
"$swiftc_bin" \
  -swift-version 5 \
  "${module_flags[@]}" \
  -o "$work/refresh-checks" \
  "$root/src-tauri/ios/RefreshPolicy.swift" \
  "$root/src-tauri/ios/FeedScanner.swift" \
  "$root/src-tauri/ios/LocalLibrary.swift" \
  "$root/src-tauri/ios/BackgroundRefresher.swift" \
  "$root/src-tauri/ios/Checks/Checks.swift"

echo
"$work/refresh-checks"
