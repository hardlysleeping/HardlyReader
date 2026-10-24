#!/usr/bin/env bash
# Start the native dev window.
#
# `pnpm tauri dev` alone comes up grey on this box: WebKitGTK's compositing path
# on Wayland paints nothing, so the window shows the shell colour and looks
# blank even though the page is running (measured: the window's own JS was
# executing and answering requests while the screen showed nothing).
# WEBKIT_DISABLE_COMPOSITING_MODE=1 makes it paint. It costs nothing on a dev
# preview, and this script exists so the flag is not a command someone has to
# remember.
set -euo pipefail

cd "$(dirname "$0")/.."

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"
export WEBKIT_DISABLE_COMPOSITING_MODE=1

exec pnpm tauri dev "$@"
