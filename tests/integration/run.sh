#!/usr/bin/env bash
#
# End-to-end harness: a disposable FreshRSS container, both extensions
# installed, the v1 API driven over real HTTP, diagnostics kept on failure.
#
#   tests/integration/run.sh
#
# Environment:
#   HARDLYREAD_E2E_PORT            host port for the harness (default 18081)
#   HARDLYREAD_E2E_PROJECT         compose project name (default hardlyread-e2e)
#   HARDLYREAD_HIDDEN_CATEGORIES_DIR
#                                  Hidden Categories source directory (default
#                                  ~/apps/freshrss/extensions-src/xExtension-HiddenCategories)
#   HARDLYREAD_FAVORITE_CATEGORIES_DIR
#                                  Pinned Categories source directory (default
#                                  ~/apps/freshrss/extensions-src/xExtension-FavoriteCategories)
#   HARDLYREAD_E2E_HEALTH_TIMEOUT  seconds to wait for the container (default 180)
#   KEEP_CONTAINERS_ON_FAILURE=1   leave the stack running after a failure
#
# The project name and port are deliberately not the defaults, so a run never
# touches the developer's harness on 18080. Every failure leaves FreshRSS and
# compose logs in tests/integration/artifacts/.
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INTEGRATION_DIR="$REPO_ROOT/tests/integration"
COMPOSE_FILE="$INTEGRATION_DIR/compose.yml"
ARTIFACTS_DIR="$INTEGRATION_DIR/artifacts"

PROJECT=${HARDLYREAD_E2E_PROJECT:-hardlyread-e2e}
PORT=${HARDLYREAD_E2E_PORT:-18081}
BASE_URL="http://127.0.0.1:$PORT"

API_EXTENSION_DIR="$REPO_ROOT/extensions/xExtension-HardlyRead"
HIDDEN_EXTENSION_DIR=${HARDLYREAD_HIDDEN_CATEGORIES_DIR:-$HOME/apps/freshrss/extensions-src/xExtension-HiddenCategories}
PINNED_EXTENSION_DIR=${HARDLYREAD_FAVORITE_CATEGORIES_DIR:-$HOME/apps/freshrss/extensions-src/xExtension-FavoriteCategories}

# Paths inside the container, matching what provision.php and compose.yml expect.
EXTENSIONS_PATH=/var/www/FreshRSS/extensions
PROVISION_PATH=/tmp/hardlyread-e2e/provision.php

export HARDLYREAD_E2E_PORT="$PORT"
export HARDLYREAD_E2E_BASE_URL="$BASE_URL"

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Set once the harness has been asked to start: before that there is nothing to
# diagnose, and a preflight error should not pretend otherwise.
STARTED=0

compose() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

container_id() {
  # Always succeeds: callers use it in tests and assignments under `set -e`.
  compose ps -q freshrss 2>/dev/null || true
}

# Runs a command in this project's container only. `docker exec` here is always
# addressed by id, never by name: the name is compose's business.
in_container() {
  local id
  id=$(container_id)
  [ -n "$id" ] || return 1
  docker exec -i "$id" "$@"
}

in_container_as() {
  local user=$1
  shift
  local id
  id=$(container_id)
  [ -n "$id" ] || return 1
  docker exec -i -u "$user" "$id" "$@"
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

wait_for_health() {
  local deadline=$((SECONDS + ${HARDLYREAD_E2E_HEALTH_TIMEOUT:-180}))
  while ((SECONDS < deadline)); do
    if in_container php cli/health.php >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

dump_store() {
  in_container php "$PROVISION_PATH" dump
}

capture_diagnostics() {
  mkdir -p "$ARTIFACTS_DIR"
  log "capturing diagnostics into ${ARTIFACTS_DIR#"$REPO_ROOT"/}"

  compose ps -a >"$ARTIFACTS_DIR/compose-ps.txt" 2>&1 || true
  compose logs --no-color --timestamps freshrss >"$ARTIFACTS_DIR/freshrss.log" 2>&1 || true

  # Selected by compose labels, so this is correct under a non-default project
  # name and cannot pick up another project's freshrss service.
  docker ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=freshrss" |
    xargs -r docker inspect >"$ARTIFACTS_DIR/freshrss-inspect.json" 2>&1 || true

  # The extension's own view of the world: what it stored, not what it said.
  dump_store >"$ARTIFACTS_DIR/hardlyread-store.json" 2>&1 || true
}

teardown() {
  # Load-bearing: an `exit` inside a trap that is still installed re-enters it.
  trap - EXIT
  if ! compose down --volumes --remove-orphans; then
    log "warning: compose down failed; containers for $PROJECT may remain"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT

  if [ "$status" -ne 0 ]; then
    if [ "$STARTED" -eq 1 ]; then
      capture_diagnostics || true
    fi
    if [ "${KEEP_CONTAINERS_ON_FAILURE:-0}" = "1" ]; then
      log "KEEP_CONTAINERS_ON_FAILURE=1 — leaving the stack up for inspection"
      log "  docker compose -f tests/integration/compose.yml -p $PROJECT ps"
      log "  docker compose -f tests/integration/compose.yml -p $PROJECT logs freshrss"
      log "  docker compose -f tests/integration/compose.yml -p $PROJECT down --volumes"
      exit "$status"
    fi
  fi

  teardown
  exit "$status"
}

trap on_exit EXIT

# --- preflight ------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available"
command -v node >/dev/null 2>&1 || die "node is not on PATH (the E2E scenario is Node)"

[ -f "$API_EXTENSION_DIR/extension.php" ] ||
  die "missing Hardly Read extension at $API_EXTENSION_DIR"
[ -f "$HIDDEN_EXTENSION_DIR/extension.php" ] ||
  die "Hidden Categories source not found at $HIDDEN_EXTENSION_DIR
       this harness installs it alongside Hardly Read, so it needs a checkout of
       xExtension-HiddenCategories that includes setCategoryHidden() and
       changeView(). Point HARDLYREAD_HIDDEN_CATEGORIES_DIR at one:
         HARDLYREAD_HIDDEN_CATEGORIES_DIR=/path/to/xExtension-HiddenCategories tests/integration/run.sh"
[ -f "$PINNED_EXTENSION_DIR/extension.php" ] ||
  die "Pinned Categories source not found at $PINNED_EXTENSION_DIR
       the favourites assertions need it installed beside the adapter (a build
       with setCategoryFavorite() and changeView()). Point
       HARDLYREAD_FAVORITE_CATEGORIES_DIR at one, or at the repo's sibling
       xExtension-FavoriteCategories checkout."

if port_in_use "$PORT"; then
  # A kept stack from a previous failed run holds this port. Reusing it is the
  # point of KEEP_CONTAINERS_ON_FAILURE, so only refuse a port held by
  # something that is not ours.
  if [ -z "$(container_id)" ]; then
    die "port $PORT is already in use by something else — set HARDLYREAD_E2E_PORT to a free port"
  fi
  log "port $PORT is held by this project's container; reusing it"
fi

rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR"

log "E2E: project=$PROJECT port=$PORT"
log "  Hardly Read:      $API_EXTENSION_DIR"
log "  Hidden Categories: $HIDDEN_EXTENSION_DIR"
log "  Pinned Categories: $PINNED_EXTENSION_DIR"

# Prepared from an empty volume every run, so a stale config cannot pass the
# suite for us.
compose config >"$ARTIFACTS_DIR/compose-config.txt"

# --- bring it up ----------------------------------------------------------

log "starting the harness"
STARTED=1
compose up -d

log "waiting for cli/health.php"
if ! wait_for_health; then
  die "the harness did not become healthy within ${HARDLYREAD_E2E_HEALTH_TIMEOUT:-180}s"
fi

# --- install both extensions ---------------------------------------------

ID=$(container_id)
[ -n "$ID" ] || die "the harness container is not running"

log "installing xExtension-HardlyRead"
docker exec "$ID" install -d "$EXTENSIONS_PATH/xExtension-HardlyRead"
docker cp "$API_EXTENSION_DIR/." "$ID:$EXTENSIONS_PATH/xExtension-HardlyRead/"

log "installing xExtension-HiddenCategories"
docker exec "$ID" install -d "$EXTENSIONS_PATH/xExtension-HiddenCategories"
tar -C "$HIDDEN_EXTENSION_DIR" --exclude=.git -cf - . |
  docker exec -i "$ID" tar -xf - -C "$EXTENSIONS_PATH/xExtension-HiddenCategories"

log "installing xExtension-FavoriteCategories"
docker exec "$ID" install -d "$EXTENSIONS_PATH/xExtension-FavoriteCategories"
tar -C "$PINNED_EXTENSION_DIR" --exclude=.git -cf - . |
  docker exec -i "$ID" tar -xf - -C "$EXTENSIONS_PATH/xExtension-FavoriteCategories"

docker exec "$ID" install -d "$(dirname "$PROVISION_PATH")"
docker cp "$INTEGRATION_DIR/provision.php" "$ID:$PROVISION_PATH"

log "enabling extensions and seeding the fixture categories"
docker exec "$ID" php "$PROVISION_PATH" config | tee "$ARTIFACTS_DIR/provision-config.json"

# The web server caches PHP files (opcache revalidate_freq=2,
# file_update_protection=2), so a config written a moment ago is not seen yet —
# every request would 404 on a system extension it has not noticed. A restart
# is the deterministic answer, and it is also what a real deployment does.
log "restarting the web server to pick up the new configuration"
compose restart freshrss >/dev/null
if ! wait_for_health; then
  die "the harness did not come back healthy after enabling the extensions"
fi

# Resets the extension's own store, so a rerun over a kept volume starts clean.
# As www-data: the store lives in the user's data directory and belongs to the
# web server, not to root.
log "resetting the Hidden Categories store"
in_container_as www-data php "$PROVISION_PATH" reset | tee "$ARTIFACTS_DIR/provision-reset.json"

# --- the scenario ---------------------------------------------------------

log "running the E2E scenario"
HARDLYREAD_STORE_DUMP="docker compose -f $(printf '%q' "$COMPOSE_FILE") -p $PROJECT exec -T freshrss php $PROVISION_PATH dump" \
  node "$INTEGRATION_DIR/e2e.mjs" 2>&1 | tee "$ARTIFACTS_DIR/e2e.log"

log "E2E passed — tearing down"
