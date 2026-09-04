#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Leash"
INSTALL_DIR="/Applications"
DMG_SOURCE=""
RULES_FILE=""
REPLACE_RULES=0
NO_LAUNCH=0
QUIET=0
KEEP_SETTINGS=0
UNINSTALL=0
API_URL=""
USER_TOKEN=""
CLIENT_MODE=""
INSTALL_HOOKS=0
AGENTS=""
INDIVIDUAL_OPEN_SOURCE=0
OPENLEASH_BACKEND_DIR="${OPENLEASH_BACKEND_DIR:-$HOME/.openleash/individual-open-source}"
OPENLEASH_IMAGE_REGISTRY="${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}"
OPENLEASH_VERSION="${OPENLEASH_VERSION:-0.37.18@sha256:c4f2f115a2c7b4bf53bad27b88f0547825e04e2cf9b61f461f8b5efa6eec673c}"

usage() {
  cat <<'EOF'
Leash personal installer

Usage:
  install-openleash-personal.sh [options]

Options:
  --dmg <path-or-url>       DMG to install. Defaults to a nearby Leash DMG.
  --target <directory>      Install directory. Defaults to /Applications.
  --rules <json>            Import rules after installation.
  --replace-rules           Replace existing rules when importing JSON.
  --api-url <url>           Personal Leash API endpoint. Defaults to Leash Cloud.
  --token <token>           Personal user token for scripted installs.
  --mode <mode>             personal, cloud, custom, or individual-open-source.
  --open-source             Install the local Personal Open Source backend.
  --backend-dir <path>      Local backend directory. Defaults to ~/.openleash/individual-open-source.
  --image-registry <host>   Docker image registry. Defaults to ghcr.io/open-leash.
  --version <tag[@digest]>  Docker image version for the local backend. Defaults to this release's verified digest.
  --install-hooks           Install supported local agent hooks after setup.
  --agents <list>           Comma-separated agent ids for hook installation.
  --keep-settings           Keep existing local Leash setup and history.
  --uninstall               Remove Leash, its local state, hooks, proxy configuration, and local backend.
  --no-launch               Install only; do not start Leash.
  --quiet                   Reduce installer output.
  --help                    Show this help.

Examples:
  ./install-openleash-personal.sh
  ./install-openleash-personal.sh --rules company-rules.json --replace-rules
  ./install-openleash-personal.sh --dmg https://example.com/Leash.dmg --quiet
EOF
}

log() {
  if [[ "$QUIET" -eq 0 ]]; then printf '%s\n' "$*" >&2; fi
}

die() {
  printf 'Leash install failed: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dmg)
      DMG_SOURCE="${2:-}"
      shift 2
      ;;
    --target)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --rules|--import-rules)
      RULES_FILE="${2:-}"
      shift 2
      ;;
    --replace-rules|--rules-replace)
      REPLACE_RULES=1
      shift
      ;;
    --api-url)
      API_URL="${2:-}"
      shift 2
      ;;
    --token|--user-token)
      USER_TOKEN="${2:-}"
      shift 2
      ;;
    --mode)
      CLIENT_MODE="${2:-}"
      if [[ "$CLIENT_MODE" == "individual-open-source" || "$CLIENT_MODE" == "open-source" ]]; then
        INDIVIDUAL_OPEN_SOURCE=1
      fi
      shift 2
      ;;
    --open-source|--individual-open-source)
      INDIVIDUAL_OPEN_SOURCE=1
      CLIENT_MODE="individual-open-source"
      shift
      ;;
    --backend-dir)
      OPENLEASH_BACKEND_DIR="${2:-}"
      shift 2
      ;;
    --image-registry)
      OPENLEASH_IMAGE_REGISTRY="${2:-}"
      shift 2
      ;;
    --version)
      OPENLEASH_VERSION="${2:-}"
      shift 2
      ;;
    --install-hooks)
      INSTALL_HOOKS=1
      shift
      ;;
    --agents)
      AGENTS="${2:-}"
      shift 2
      ;;
    --keep-settings)
      KEEP_SETTINGS=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --no-launch)
      NO_LAUNCH=1
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
MOUNT_POINT=""
INSTALL_STAGE=""
INSTALL_BACKUP=""

remove_install_path() {
  local target="$1"
  [[ -n "$target" && -e "$target" ]] || return 0
  chflags -R nouchg,noschg "$target" >/dev/null 2>&1 || true
  chmod -RN "$target" >/dev/null 2>&1 || true
  chmod -R u+rwX "$target" >/dev/null 2>&1 || true
  if rm -rf -- "$target" 2>/dev/null; then
    return 0
  fi
  sudo chflags -R nouchg,noschg "$target" >/dev/null 2>&1 || true
  sudo chmod -RN "$target" >/dev/null 2>&1 || true
  sudo chmod -R u+rwX "$target" >/dev/null 2>&1 || true
  sudo rm -rf -- "$target"
}

make_install_path_replaceable() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  chflags -R nouchg,noschg "$target" >/dev/null 2>&1 ||
    sudo chflags -R nouchg,noschg "$target" >/dev/null 2>&1 || true
  chmod -RN "$target" >/dev/null 2>&1 ||
    sudo chmod -RN "$target" >/dev/null 2>&1 || true
  chmod -R u+rwX "$target" >/dev/null 2>&1 ||
    sudo chmod -R u+rwX "$target" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [[ -n "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  if [[ -n "$INSTALL_STAGE" ]]; then
    remove_install_path "$INSTALL_STAGE" || true
  fi
  if [[ -n "$INSTALL_BACKUP" ]]; then
    remove_install_path "$INSTALL_BACKUP" || true
  fi
  rm -rf "$TMP_DIR"
  return "$status"
}
trap cleanup EXIT

resolve_dmg() {
  if [[ -n "$DMG_SOURCE" ]]; then
    if [[ "$DMG_SOURCE" =~ ^https?:// ]]; then
      local downloaded="$TMP_DIR/Leash.dmg"
      log "Downloading Leash DMG..."
      curl -fL "$DMG_SOURCE" -o "$downloaded"
      printf '%s\n' "$downloaded"
      return
    fi
    [[ -f "$DMG_SOURCE" ]] || die "DMG not found: $DMG_SOURCE"
    printf '%s\n' "$DMG_SOURCE"
    return
  fi

  local nearby
  nearby="$(find "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$PWD" "$PWD/release/personal" -maxdepth 2 -name 'Leash*.dmg' -type f 2>/dev/null | head -n 1 || true)"
  [[ -n "$nearby" ]] || die "No Leash DMG found. Pass --dmg <path-or-url>."
  printf '%s\n' "$nearby"
}

copy_app() {
  local source_app="$1"
  local target_app="$INSTALL_DIR/$APP_NAME.app"
  local stage_app="$INSTALL_DIR/.$APP_NAME.app.installing.$$"
  local backup_app="$INSTALL_DIR/.$APP_NAME.app.previous.$$"
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true

  INSTALL_STAGE="$stage_app"
  remove_install_path "$stage_app"
  remove_install_path "$backup_app"
  log "Preparing $APP_NAME for installation..."
  if [[ -w "$INSTALL_DIR" ]]; then
    ditto "$source_app" "$stage_app" || die "Could not stage the Leash application."
    xattr -cr "$stage_app" 2>/dev/null || true
    codesign --force --deep --sign - "$stage_app" >/dev/null 2>&1 ||
      die "Could not apply the local macOS signature."
    codesign --verify --deep --strict "$stage_app" >/dev/null 2>&1 ||
      die "The locally signed Leash app did not pass code-signature verification."
    xattr -cr "$stage_app" 2>/dev/null || true
  else
    sudo ditto "$source_app" "$stage_app" || die "Could not stage the Leash application."
    sudo xattr -cr "$stage_app" 2>/dev/null || true
    sudo codesign --force --deep --sign - "$stage_app" >/dev/null 2>&1 ||
      die "Could not apply the local macOS signature."
    sudo codesign --verify --deep --strict "$stage_app" >/dev/null 2>&1 ||
      die "The locally signed Leash app did not pass code-signature verification."
    sudo xattr -cr "$stage_app" 2>/dev/null || true
  fi

  # A settings-preserving update lets the new app snapshot the currently
  # protected agents, clean the old integration, and restore it with the new
  # bundle. Cleaning here would erase that snapshot before startup.
  if [[ "$HAD_EXISTING_LOCAL_STATE" -eq 1 && "$KEEP_SETTINGS" -eq 0 ]]; then
    cleanup_existing_integrations "$stage_app"
  fi

  stop_openleash
  log "Installing $APP_NAME to $target_app..."
  if [[ -e "$target_app" ]]; then
    make_install_path_replaceable "$target_app"
    if [[ -w "$INSTALL_DIR" ]]; then
      mv "$target_app" "$backup_app" || die "Could not move the previous Leash app out of the way."
    else
      sudo mv "$target_app" "$backup_app" || die "Could not move the previous Leash app out of the way."
    fi
    INSTALL_BACKUP="$backup_app"
  fi
  if [[ -w "$INSTALL_DIR" ]]; then
    if ! mv "$stage_app" "$target_app"; then
      [[ -e "$backup_app" ]] && mv "$backup_app" "$target_app" || true
      die "Could not activate the new Leash app. The previous app was restored."
    fi
  else
    if ! sudo mv "$stage_app" "$target_app"; then
      [[ -e "$backup_app" ]] && sudo mv "$backup_app" "$target_app" || true
      die "Could not activate the new Leash app. The previous app was restored."
    fi
  fi
  INSTALL_STAGE=""
  if [[ -n "$INSTALL_BACKUP" ]]; then
    remove_install_path "$INSTALL_BACKUP"
    INSTALL_BACKUP=""
  fi
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target_app" >/dev/null 2>&1 || true
}

leash_processes_running() {
  pgrep -f "/Leash.app/" >/dev/null 2>&1 ||
    pgrep -f "/OpenLeash.app/" >/dev/null 2>&1
}

stop_leash_launch_jobs() {
  local label
  while IFS= read -r label; do
    case "$label" in
      com.openleash.*|com.leash.*)
        launchctl remove "$label" >/dev/null 2>&1 || true
        ;;
    esac
  done < <(launchctl list 2>/dev/null | awk '{print $3}')
  launchctl remove com.openleash.installer-launch >/dev/null 2>&1 || true
  launchctl remove com.openleash.local-release-launch >/dev/null 2>&1 || true
}

stop_openleash() {
  stop_leash_launch_jobs
  if leash_processes_running; then
    log "Stopping existing Leash..."
    pkill -TERM -f "/Leash.app/" || true
    pkill -TERM -f "/OpenLeash.app/" || true
    for _ in $(seq 1 40); do
      leash_processes_running || break
      sleep 0.25
    done
    pkill -KILL -f "/Leash.app/" || true
    pkill -KILL -f "/OpenLeash.app/" || true
    for _ in $(seq 1 20); do
      leash_processes_running || return 0
      sleep 0.1
    done
    die "Could not stop the running Leash application."
  fi
}

remove_retired_feature_containers() {
  command -v docker >/dev/null 2>&1 || return 0
  log "Removing retired containerized Feature runtimes..."
  docker rm -f \
    openleash-plugin-gateway \
    openleash-plugin-dlp \
    openleash-plugin-sensitive-access \
    openleash-plugin-rules-enforcer \
    openleash-plugin-mcp-scanner \
    openleash-plugin-code-scanner \
    openleash-plugin-skill-scanner \
    openleash-plugin-siem-exporter \
    openleash-plugin-token-saver \
    openleash-plugin-blast-radius \
    >/dev/null 2>&1 || true
}

cleanup_existing_integrations() {
  local target_app="$1"
  local executable="$target_app/Contents/MacOS/$APP_NAME"
  local resources="$target_app/Contents/Resources"
  [[ -x "$executable" ]] || die "Installed Leash executable was not found for integration cleanup."
  log "Removing existing Leash hooks and proxy configuration..."
  if ! env ELECTRON_RUN_AS_NODE=1 "$executable" -e '
    const fs = require("node:fs");
    const resources = process.argv[1];
    const roots = [
      `${resources}/app.asar/dist`,
      `${resources}/app.asar/apps/desktop/dist`,
    ];
    const base = roots.find((candidate) => fs.existsSync(`${candidate}/proxy-manager.js`));
    if (!base) throw new Error("Packaged integration cleanup modules are missing.");
    (async () => {
      await require(`${base}/proxy-manager.js`).uninstallLocalProxy();
      await require(`${base}/agent-registry.js`).uninstallAllAgentProtections();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  ' "$resources" >/dev/null; then
    die "Could not remove the previous Leash agent integrations. Agent configuration was not replaced."
  fi
}

uninstall_openleash() {
  local target_app="$INSTALL_DIR/$APP_NAME.app"
  local executable="$target_app/Contents/MacOS/$APP_NAME"
  stop_openleash
  if [[ -x "$executable" ]]; then
    cleanup_existing_integrations "$target_app"
  else
    die "Leash.app is required to safely restore agent configuration before uninstalling. Reinstall it, then rerun with --uninstall."
  fi

  if [[ -f "$OPENLEASH_BACKEND_DIR/docker-compose.yml" ]]; then
    command -v docker >/dev/null 2>&1 ||
      die "Docker is required to remove the installed Personal Open Source runtime. Start Docker Desktop, then retry."
    docker info >/dev/null 2>&1 ||
      die "Start Docker Desktop so Leash can remove its Personal Open Source containers and data, then retry."
    local compose
    local leash_images
    compose="$(docker_compose_cmd)"
    leash_images="$(cd "$OPENLEASH_BACKEND_DIR" && $compose --profile setup config --images 2>/dev/null | grep -E '/client-api(:|@)' | sort -u || true)"
    (cd "$OPENLEASH_BACKEND_DIR" && $compose down -v --remove-orphans)
    if [[ -n "$leash_images" ]]; then
      while IFS= read -r image; do
        [[ -n "$image" ]] && docker image rm -f "$image" >/dev/null 2>&1 || true
      done <<<"$leash_images"
    fi
  fi
  remove_retired_feature_containers

  log "Removing Leash application and local state..."
  if [[ -w "$INSTALL_DIR" ]]; then rm -rf "$target_app"; else sudo rm -rf "$target_app"; fi
  rm -rf \
    "$HOME/.openleash" \
    "$HOME/Library/Application Support/OpenLeash" \
    "$HOME/Library/Application Support/Leash" \
    "$HOME/Library/Application Support/com.openleash.personal" \
    "$HOME/Library/Caches/Leash" \
    "$HOME/Library/Caches/com.openleash.personal" \
    "$HOME/Library/Caches/leash-island" \
    "$HOME/Library/Caches/openleash-island" \
    "$HOME/Library/HTTPStorages/com.openleash.personal" \
    "$HOME/Library/Logs/Leash" \
    "$HOME/Library/Logs/OpenLeash" \
    "$HOME/Library/Saved Application State/com.openleash.personal.savedState" \
    "$HOME/Library/Saved Application State/com.openleash.openleash.savedState" \
    "$HOME/Library/WebKit/com.openleash.personal" \
    "$HOME/Library/WebKit/leash-island" \
    "$HOME/Library/WebKit/openleash-island"
  rm -f \
    "$HOME/Library/Preferences/com.openleash.personal.plist" \
    "$HOME/Library/LaunchAgents/com.openleash.personal.plist" \
    "$HOME/Library/LaunchAgents/com.openleash.installer-launch.plist" \
    "$HOME/Library/LaunchAgents/com.openleash.local-release-launch.plist" \
    "$HOME/Library/LaunchAgents/com.leash.personal.plist"
  rm -f /tmp/openleash-launch.log /tmp/openleash-startup.log
  log "Leash uninstalled. Agent hooks and proxy configuration were restored."
}

reset_settings() {
  if [[ "$KEEP_SETTINGS" -eq 1 ]]; then
    return
  fi
  log "Removing previous Leash local state for a clean installation..."
  if [[ -f "$OPENLEASH_BACKEND_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    local compose
    compose="$(docker_compose_cmd)"
    (cd "$OPENLEASH_BACKEND_DIR" && $compose down -v --remove-orphans) || true
  fi
  rm -rf \
    "$HOME/.openleash" \
    "$HOME/Library/Application Support/Leash" \
    "$HOME/Library/Application Support/OpenLeash" \
    "$HOME/Library/Logs/Leash" \
    "$HOME/Library/Logs/OpenLeash" \
    "$HOME/Library/WebKit/leash-island" \
    "$HOME/Library/WebKit/openleash-island" \
    "$HOME/Library/Caches/leash-island" \
    "$HOME/Library/Caches/openleash-island" \
    "$HOME/Library/Saved Application State/com.openleash.personal.savedState" \
    "$HOME/Library/Saved Application State/com.openleash.openleash.savedState"
}

docker_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    printf 'docker compose'
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    printf 'docker-compose'
    return
  fi
  die "Docker Compose was not found. Install Docker Desktop, Colima with Docker Compose, or OrbStack, then rerun with --open-source."
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    uuidgen | tr -d '-' | tr '[:upper:]' '[:lower:]'
  fi
}

write_individual_open_source_runtime() {
  mkdir -p "$OPENLEASH_BACKEND_DIR/backups" "$OPENLEASH_BACKEND_DIR/migration-logs"
  if [[ ! -f "$OPENLEASH_BACKEND_DIR/.env" ]]; then
    cat > "$OPENLEASH_BACKEND_DIR/.env" <<EOF
OPENLEASH_IMAGE_REGISTRY=$OPENLEASH_IMAGE_REGISTRY
OPENLEASH_VERSION=$OPENLEASH_VERSION
OPENLEASH_POSTGRES_DB=openleash
OPENLEASH_POSTGRES_USER=openleash
OPENLEASH_POSTGRES_PASSWORD=$(random_secret)
OPENLEASH_CLIENT_API_PORT=9318
OPENLEASH_RELEASE_ADMIN_TOKEN=$(random_secret)
OPENLEASH_MODEL_KEY_ENCRYPTION_KEY=$(random_secret)
OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY=$(random_secret)
OPENLEASH_SECRET_KEY=$(random_secret)
OPENLEASH_DEV_TOKEN=
OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED=1
OPENLEASH_DEV_ORG_SLUG=individual-open-source
OPENLEASH_DEV_ORG_NAME=Individual Open Source
EOF
  else
    if ! grep -q '^OPENLEASH_IMAGE_REGISTRY=' "$OPENLEASH_BACKEND_DIR/.env"; then
      printf '\nOPENLEASH_IMAGE_REGISTRY=%s\n' "$OPENLEASH_IMAGE_REGISTRY" >> "$OPENLEASH_BACKEND_DIR/.env"
    fi
    if grep -q '^OPENLEASH_VERSION=' "$OPENLEASH_BACKEND_DIR/.env"; then
      sed -i.bak "s/^OPENLEASH_VERSION=.*/OPENLEASH_VERSION=$OPENLEASH_VERSION/" "$OPENLEASH_BACKEND_DIR/.env" && rm -f "$OPENLEASH_BACKEND_DIR/.env.bak"
    else
      printf 'OPENLEASH_VERSION=%s\n' "$OPENLEASH_VERSION" >> "$OPENLEASH_BACKEND_DIR/.env"
    fi
  fi

  cat > "$OPENLEASH_BACKEND_DIR/docker-compose.yml" <<'EOF'
name: openleash-individual

services:
  postgres:
    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
    container_name: openleash-individual-postgres
    environment:
      POSTGRES_DB: ${OPENLEASH_POSTGRES_DB:-openleash}
      POSTGRES_USER: ${OPENLEASH_POSTGRES_USER:-openleash}
      POSTGRES_PASSWORD: ${OPENLEASH_POSTGRES_PASSWORD:-openleash}
    volumes:
      - openleash-individual-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${OPENLEASH_POSTGRES_USER:-openleash} -d ${OPENLEASH_POSTGRES_DB:-openleash}"]
      interval: 5s
      timeout: 5s
      retries: 20

  migrate:
    image: ${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:${OPENLEASH_VERSION:-0.37.18@sha256:c4f2f115a2c7b4bf53bad27b88f0547825e04e2cf9b61f461f8b5efa6eec673c}
    profiles: ["setup"]
    user: "0:0"
    environment:
      DATABASE_URL: postgres://${OPENLEASH_POSTGRES_USER:-openleash}:${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/${OPENLEASH_POSTGRES_DB:-openleash}
      OPENLEASH_DEV_TOKEN: ${OPENLEASH_DEV_TOKEN:-}
      OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED: ${OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED:-1}
      OPENLEASH_DEV_ORG_SLUG: individual-open-source
      OPENLEASH_DEV_ORG_NAME: Individual Open Source
      OPENLEASH_DEPLOYMENT_MODE: individual-open-source
      OPENLEASH_MIGRATION_LOG_DIR: /var/log/openleash
    volumes:
      - ./migration-logs:/var/log/openleash
    command: ["node", "apps/client-api/dist/migrate.js", "--apply"]
    depends_on:
      postgres:
        condition: service_healthy

  seed:
    image: ${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:${OPENLEASH_VERSION:-0.37.18@sha256:c4f2f115a2c7b4bf53bad27b88f0547825e04e2cf9b61f461f8b5efa6eec673c}
    profiles: ["setup"]
    environment:
      DATABASE_URL: postgres://${OPENLEASH_POSTGRES_USER:-openleash}:${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/${OPENLEASH_POSTGRES_DB:-openleash}
    command: ["node", "apps/client-api/dist/bootstrap-personal.js", "--name", "Individual Open Source", "--slug", "individual-open-source", "--mode", "private"]
    depends_on:
      postgres:
        condition: service_healthy

  client-api:
    image: ${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:${OPENLEASH_VERSION:-0.37.18@sha256:c4f2f115a2c7b4bf53bad27b88f0547825e04e2cf9b61f461f8b5efa6eec673c}
    container_name: openleash-individual-client-api
    environment:
      DATABASE_URL: postgres://${OPENLEASH_POSTGRES_USER:-openleash}:${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/${OPENLEASH_POSTGRES_DB:-openleash}
      OPENLEASH_API_PORT: 9318
      OPENLEASH_API_SURFACE: client
      OPENLEASH_DEPLOYMENT_MODE: individual-open-source
      OPENLEASH_DEV_ORG_SLUG: individual-open-source
      OPENLEASH_DEV_ORG_NAME: Individual Open Source
      OPENLEASH_DEV_TOKEN: ${OPENLEASH_DEV_TOKEN:-}
      OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED: ${OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED:-1}
      OPENLEASH_RELEASE_ADMIN_TOKEN: ${OPENLEASH_RELEASE_ADMIN_TOKEN:-local-release-admin-token}
      OPENLEASH_MODEL_KEY_ENCRYPTION_KEY: ${OPENLEASH_MODEL_KEY_ENCRYPTION_KEY:-openleash-local-model-key-change-me}
      OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY: ${OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY:-openleash-local-provider-key-change-me}
      OPENLEASH_SECRET_KEY: ${OPENLEASH_SECRET_KEY:-openleash-local-secret-change-me}
    ports:
      - "127.0.0.1:${OPENLEASH_CLIENT_API_PORT:-9318}:9318"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  openleash-individual-postgres:
EOF
}

install_individual_open_source_backend() {
  command -v docker >/dev/null 2>&1 || die "Docker was not found. Install Docker Desktop, Colima, or OrbStack, then rerun with --open-source."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker, then rerun with --open-source."
  local compose
  compose="$(docker_compose_cmd)"
  write_individual_open_source_runtime
  log "Starting Leash Personal Open Source backend in $OPENLEASH_BACKEND_DIR..."
  (cd "$OPENLEASH_BACKEND_DIR" && $compose --profile setup pull)
  (cd "$OPENLEASH_BACKEND_DIR" && $compose up -d postgres)
  (cd "$OPENLEASH_BACKEND_DIR" && $compose --profile setup run --rm migrate)
  (cd "$OPENLEASH_BACKEND_DIR" && $compose --profile setup run --rm seed)
  (cd "$OPENLEASH_BACKEND_DIR" && $compose up -d client-api)
  API_URL="http://127.0.0.1:9318"
  local ready=0
  for _ in $(seq 1 90); do
    if curl -fsS "$API_URL/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [[ "$ready" -ne 1 ]]; then
    (cd "$OPENLEASH_BACKEND_DIR" && $compose logs --tail=100 client-api) >&2 || true
    die "Leash Personal Open Source backend did not become healthy within 180 seconds."
  fi
  CLIENT_MODE="custom"
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_openleash
  exit 0
fi

# The updater always passes --keep-settings. If this installation already has
# the Personal Open Source backend, upgrade that backend in place as part of the
# same update: pull the release image, apply migrations, seed idempotently, and
# restart the client API. A normal install intentionally starts with no backend
# or desktop state.
if [[ "$KEEP_SETTINGS" -eq 1 && -f "$OPENLEASH_BACKEND_DIR/docker-compose.yml" ]]; then
  INDIVIDUAL_OPEN_SOURCE=1
  CLIENT_MODE="custom"
fi

DMG_PATH="$(resolve_dmg)"
[[ -z "$RULES_FILE" || -f "$RULES_FILE" ]] || die "Rules JSON not found: $RULES_FILE"

HAD_EXISTING_LOCAL_STATE=0
if [[ -d "$HOME/Library/Application Support/Leash" || -d "$HOME/Library/Application Support/OpenLeash" ]]; then
  HAD_EXISTING_LOCAL_STATE=1
fi

stop_openleash
# Fresh Cloud installs never inspect or invoke Docker. Legacy container cleanup
# is only relevant to an existing Leash installation or an explicitly selected
# Personal Open Source installation.
if [[ "$HAD_EXISTING_LOCAL_STATE" -eq 1 || "$INDIVIDUAL_OPEN_SOURCE" -eq 1 ]]; then
  remove_retired_feature_containers
fi

MOUNT_POINT="$TMP_DIR/mount"
mkdir -p "$MOUNT_POINT"
log "Mounting $DMG_PATH..."
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -quiet

SOURCE_APP="$(find "$MOUNT_POINT" -maxdepth 2 -name "$APP_NAME.app" -type d | head -n 1 || true)"
[[ -n "$SOURCE_APP" ]] || die "$APP_NAME.app not found in DMG."

TARGET_APP="$INSTALL_DIR/$APP_NAME.app"
copy_app "$SOURCE_APP"
reset_settings

if [[ "$INDIVIDUAL_OPEN_SOURCE" -eq 1 ]]; then
  install_individual_open_source_backend
fi

if [[ "$NO_LAUNCH" -eq 0 ]]; then
  args=(--show-window)
  if [[ "$KEEP_SETTINGS" -eq 1 ]]; then
    args+=(--keep-settings)
  else
    args+=(--fresh-install)
  fi
  if [[ -n "$RULES_FILE" ]]; then
    args+=(--import-rules "$RULES_FILE")
    if [[ "$REPLACE_RULES" -eq 1 ]]; then args+=(--replace-rules); fi
  fi
  if [[ -n "$API_URL" ]]; then args+=(--api-url "$API_URL"); fi
  if [[ -n "$USER_TOKEN" ]]; then args+=(--token "$USER_TOKEN"); fi
  if [[ -n "$CLIENT_MODE" ]]; then args+=(--mode "$CLIENT_MODE"); fi
  if [[ "$INSTALL_HOOKS" -eq 1 ]]; then args+=(--install-hooks); fi
  if [[ -n "$AGENTS" ]]; then args+=(--agents "$AGENTS"); fi
  log "Starting $APP_NAME..."
  app_executable="$TARGET_APP/Contents/MacOS/$APP_NAME"
  if [[ -x "$app_executable" ]]; then
    # A submitted launchctl job is inferred as KeepAlive on macOS. Keeping the
    # installer-owned job around would relaunch Leash with --fresh-install on
    # every quit and reset a completed setup. Launch through Launch Services so
    # the first-run flags apply exactly once and normal app restarts stay normal.
    launchctl remove com.openleash.installer-launch >/dev/null 2>&1 || true
    /usr/bin/env -u ELECTRON_RUN_AS_NODE open -na "$TARGET_APP" --args "${args[@]}"
    sleep 2
    if ! pgrep -f "$app_executable" >/dev/null 2>&1; then
      log "The first launch ended early; retrying once..."
      sleep 1
      /usr/bin/env -u ELECTRON_RUN_AS_NODE open -na "$TARGET_APP" --args "${args[@]}"
      sleep 2
      pgrep -f "$app_executable" >/dev/null 2>&1 ||
        die "Leash was installed but could not stay running."
    fi
  else
    if [[ "${#args[@]}" -gt 0 ]]; then
      open "$TARGET_APP" --args "${args[@]}"
    else
      open "$TARGET_APP"
    fi
  fi
fi

log "Leash installed."
