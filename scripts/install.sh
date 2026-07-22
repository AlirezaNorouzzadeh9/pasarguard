#!/usr/bin/env bash
#
# PasarGuard Panel — Docker installer (multi-backend fork)
# --------------------------------------------------------
# Installs the panel as a Docker container from this fork's prebuilt image
# (dashboard baked in). Run with no argument for an interactive menu: set the
# panel port, then install. It installs Docker if missing, writes a
# docker-compose.yml + .env, brings the container up, waits until the panel
# answers, and offers to create the first sudo admin.
#
#   sudo bash -c "$(curl -sL https://github.com/AlirezaNorouzzadeh9/pasarguard/raw/main/scripts/install.sh)"
#   sudo bash install.sh install --port 8000 -y            # scripted
#   sudo bash install.sh update | restart | status | logs | cli ... | uninstall
#
# After install the script is also available as the `pasarguard` command:
#   pasarguard status | logs | restart | update | cli admin create --sudo
#
set -euo pipefail

# ---- defaults (override via flags / env) -----------------------------------
REPO="${REPO:-https://github.com/AlirezaNorouzzadeh9/pasarguard}"
IMAGE="${IMAGE:-ghcr.io/alirezanorouzzadeh9/pasarguard:latest}"
BRANCH="${BRANCH:-main}"

SERVICE="${SERVICE:-pasarguard}"              # container name + compose project
INSTALL_DIR="${INSTALL_DIR:-/opt/pasarguard}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"
DATA_DIR="${DATA_DIR:-/var/lib/pasarguard}"
BIN_LINK="/usr/local/bin/pasarguard"

PANEL_PORT="${PANEL_PORT:-8000}"
BUILD_FROM_SOURCE=0                           # 1 -> compose builds the image locally
ASSUME_YES=0
QUIET="${QUIET:-0}"                           # 1 -> hide docker pull/build output

# ---- colors / logging -------------------------------------------------------
if [ -t 1 ]; then
  c_grn='\033[0;32m'; c_yel='\033[0;33m'; c_red='\033[0;31m'
  c_cyn='\033[0;36m'; c_mag='\033[0;35m'; c_bld='\033[1m'; c_dim='\033[2m'; c_off='\033[0m'
else
  c_grn=''; c_yel=''; c_red=''; c_cyn=''; c_mag=''; c_bld=''; c_dim=''; c_off=''
fi
log()  { echo -e "${c_grn}[+]${c_off} $*"; }
warn() { echo -e "${c_yel}[!]${c_off} $*"; }
err()  { echo -e "${c_red}[x]${c_off} $*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { echo -e "${c_cyn}────────────────────────────────────────────────────────${c_off}"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# Read that works under `curl … | bash` too.
_read() { if [ -e /dev/tty ]; then read "$@" </dev/tty || true; else read "$@" || true; fi; }

# Quiet step with colored progress; output goes to the log file. Use this only
# for steps that finish instantly — anything that can take minutes should use
# run_step_live so the user can see it working instead of staring at a frozen
# line and assuming it hung.
STEP_LOG="/tmp/pg-panel-docker.log"
run_step() {
  local msg="$1"; shift
  echo -ne "  ${c_cyn}▶${c_off} ${msg} ${c_dim}...${c_off} "
  if "$@" >>"$STEP_LOG" 2>&1; then
    echo -e "${c_grn}done${c_off}"
  else
    echo -e "${c_red}failed${c_off}"
    err "step failed: ${msg}"; err "last lines of ${STEP_LOG}:"; tail -n 12 "$STEP_LOG" >&2 || true
    exit 1
  fi
}

# run_step variant that returns non-zero instead of exiting (for soft fallbacks).
run_step_soft() {
  local msg="$1"; shift
  echo -ne "  ${c_cyn}▶${c_off} ${msg} ${c_dim}...${c_off} "
  if "$@" >>"$STEP_LOG" 2>&1; then echo -e "${c_grn}done${c_off}"; return 0
  else echo -e "${c_yel}skipped${c_off}"; return 1; fi
}

_rule() { echo -e "${c_dim}    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${c_off}"; }

# Runs "$@" with its output visible, and returns its exit status.
# Same rationale as the node installer: never pipe (subshell would eat
# COMPOSE_CMD), and give docker the TTY when there is one so its progress
# renders in place instead of thousands of "Extracting 1B" lines.
_stream() {
  local fd rc
  if [ -t 1 ]; then
    "$@"
    rc=$?
  else
    exec {fd}> >(tee -a "$STEP_LOG" | sed "s/^/    /")
    "$@" >&"$fd" 2>&1
    rc=$?
    exec {fd}>&-
    wait 2>/dev/null || true   # reap, so output can't land after the result line
  fi
  return $rc
}

# Long step whose output the user should watch live (docker pull/build/up).
run_step_live() {
  local msg="$1"; shift
  if [ "${QUIET:-0}" = "1" ]; then run_step "$msg" "$@"; return; fi
  echo -e "  ${c_cyn}▶${c_off} ${c_bld}${msg}${c_off}"
  _rule
  if _stream "$@"; then
    _rule; echo -e "  ${c_grn}✔${c_off} ${msg}"
  else
    _rule; echo -e "  ${c_red}✘${c_off} ${msg}"
    err "step failed: ${msg} (full log: ${STEP_LOG})"
    exit 1
  fi
}

# run_step_live variant that returns non-zero instead of exiting.
run_step_live_soft() {
  local msg="$1"; shift
  if [ "${QUIET:-0}" = "1" ]; then run_step_soft "$msg" "$@"; return; fi
  echo -e "  ${c_cyn}▶${c_off} ${c_bld}${msg}${c_off}"
  _rule
  if _stream "$@"; then
    echo -e "  ${c_grn}✔${c_off} ${msg}"; return 0
  else
    echo -e "  ${c_yel}▷${c_off} ${msg} — ${c_yel}skipped${c_off}"; return 1
  fi
}

# ---- input prompts (strict) -------------------------------------------------
ask_yn() {
  local q="$1" ans
  while true; do
    _read -r -p "$(echo -e "${c_bld}${q}${c_off} (y/n, Enter = no): ")" ans
    case "${ans:-n}" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
      *) warn "Please type only 'y' (yes) or 'n' (no)." ;;
    esac
  done
}
ask_num() {
  local q="$1" def="$2" ans
  while true; do
    _read -r -p "$(echo -e "${c_bld}${q}${c_off} [${def}]: ")" ans
    ans="${ans:-$def}"
    if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le 65535 ]; then echo "$ans"; return; fi
    warn "Please enter a port between 1 and 65535."
  done
}

# ---- system helpers ---------------------------------------------------------
require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

# `docker compose` (v2 plugin) or the legacy `docker-compose`.
COMPOSE_CMD=""
detect_compose() {
  if docker compose version >/dev/null 2>&1; then COMPOSE_CMD="docker compose"
  elif has docker-compose; then COMPOSE_CMD="docker-compose"
  else return 1; fi
}
dc() { ( cd "$INSTALL_DIR" && $COMPOSE_CMD "$@" ); }

# Fresh VPS images kick off unattended-upgrades / apt-daily on first boot, which
# holds the dpkg lock for the first few minutes. get.docker.com then dies with
#   E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process N
# Wait it out instead of failing the install on a brand new server.
apt_busy() {
  local f
  for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
           /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do
    [ -e "$f" ] || continue
    if has fuser && fuser "$f" >/dev/null 2>&1; then return 0; fi
  done
  # fuser isn't always installed; fall back to spotting the processes themselves.
  if has pgrep; then
    local p
    for p in apt apt-get dpkg; do
      pgrep -x "$p" >/dev/null 2>&1 && return 0
    done
    pgrep -f unattended-upgr >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Best-effort name of whatever is holding the lock, so the wait isn't a black box.
apt_holder() {
  local f p
  for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
           /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do
    [ -e "$f" ] || continue
    has fuser || break
    p=$(fuser "$f" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1)
    [ -n "$p" ] && { ps -o comm= -p "$p" 2>/dev/null | tail -1; return; }
  done
  if has pgrep; then
    for p in unattended-upgr apt apt-get dpkg; do
      pgrep -x "$p" >/dev/null 2>&1 && { echo "$p"; return; }
    done
  fi
  echo "another apt/dpkg process"
}

wait_for_apt() {
  has apt-get || return 0            # not a debian-family box; nothing to wait on
  apt_busy || return 0               # already free — don't print anything
  # unattended-upgrades on a brand new VPS routinely runs 5-15 minutes.
  local waited=0 max="${APT_LOCK_TIMEOUT:-900}"
  log "apt/dpkg is busy ($(apt_holder)) — normal on a fresh VPS; waiting up to $((max / 60))m..."
  while apt_busy; do
    if [ "$waited" -ge "$max" ]; then
      warn "apt is still locked after $((max / 60))m (holder: $(apt_holder))."
      warn "Either wait for it to finish and re-run, or:"
      warn "  APT_LOCK_TIMEOUT=1800 bash install.sh    # wait longer"
      warn "  systemctl stop unattended-upgrades       # stop the updater, then re-run"
      return 1
    fi
    sleep 3; waited=$((waited + 3))
    # a heartbeat every 30s so a long wait doesn't look like a hang
    [ $((waited % 30)) -eq 0 ] && log "  still waiting... ${waited}s elapsed (holder: $(apt_holder))"
  done
  log "apt is free (waited ${waited}s) — continuing"
}

install_docker() {
  if ! has docker; then
    wait_for_apt || die "apt is locked by another process — see above"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || true
  fi
  detect_compose || die "docker compose plugin not available after install"
}

usage() {
  cat <<EOF
PasarGuard Panel — Docker installer

Usage: sudo bash install.sh [command] [options]

Commands:
  (no command) / menu   Interactive menu (set the port, then install)
  install               Install / reinstall the container
  update                Pull the latest image (or rebuild) and recreate
  restart | status | logs
  cli <args...>         Run pasarguard-cli inside the container
                        (e.g.  cli admin create --sudo)
  uninstall             Stop and remove the container (asks about data)

Install options (skip the menu with -y):
  --port <n>            panel HTTP port (default: ${PANEL_PORT})
  --image <ref>         image to pull (default: ${IMAGE})
  --build               build the image from source instead of pulling
  --branch <name> | --repo <url>
  -y, --yes             non-interactive
  -q, --quiet           hide docker pull/build output (default: show it live)
  -h, --help

After install the script is available as the 'pasarguard' command.
Docker pull/build/up stream their output so you can watch progress; the full
log is always kept at ${STEP_LOG}.
EOF
}

parse_install_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --port|--panel-port) PANEL_PORT="$2"; shift 2 ;;
      --image) IMAGE="$2"; shift 2 ;;
      --build) BUILD_FROM_SOURCE=1; shift ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --repo) REPO="$2"; shift 2 ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -q|--quiet) QUIET=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
}

# ---- interactive menu -------------------------------------------------------
press_enter() { echo; _read -r -p "$(echo -e "  ${c_dim}Press Enter to return to the menu…${c_off}")" _; }

banner() {
  clear 2>/dev/null || true
  echo
  echo -e "  ${c_cyn}${c_bld}╔══════════════════════════════════════════════════════╗${c_off}"
  echo -e "  ${c_cyn}${c_bld}║${c_off}       ${c_bld}PasarGuard Panel${c_off}  ${c_dim}·${c_off}  ${c_mag}${c_bld}Docker install${c_off}        ${c_cyn}${c_bld}║${c_off}"
  echo -e "  ${c_cyn}${c_bld}╚══════════════════════════════════════════════════════╝${c_off}"
  echo
}

menu_command() {
  require_root
  if [ ! -e /dev/tty ] && [ ! -t 0 ]; then
    die "no terminal for the menu — run non-interactively, e.g.:
  sudo bash install.sh install --port 8000 -y   (see --help)"
  fi
  # An existing install's .env wins as the port default.
  if [ -f "$ENV_FILE" ]; then
    local envport
    envport="$(grep -E '^ *UVICORN_PORT *=' "$ENV_FILE" | tail -1 | sed 's/.*= *//; s/[" ]//g')" || true
    [ -n "${envport:-}" ] && PANEL_PORT="$envport"
  fi
  local status="not installed"
  has docker && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$SERVICE" && \
    status="installed ($(docker inspect -f '{{.State.Status}}' "$SERVICE" 2>/dev/null))"

  while true; do
    banner
    echo -e "  ${c_dim}State:${c_off} ${c_bld}${status}${c_off}   ${c_dim}image:${c_off} $([ "$BUILD_FROM_SOURCE" = 1 ] && echo 'build from source' || echo "$IMAGE")"
    echo
    echo -e "  ${c_bld}Settings${c_off}"
    printf "    ${c_bld}1${c_off}  %-24s ${c_cyn}%s${c_off}\n" "Panel port (HTTP)" "$PANEL_PORT"
    printf "    ${c_bld}2${c_off}  %-24s ${c_cyn}%s${c_off}\n" "Image source"      "$([ "$BUILD_FROM_SOURCE" = 1 ] && echo 'build from source' || echo 'pull (ghcr)')"
    echo -e "    ${c_dim}TLS/domains: run the panel behind your reverse proxy, or set the${c_off}"
    echo -e "    ${c_dim}UVICORN_SSL_* variables in ${ENV_FILE} after install.${c_off}"
    echo
    echo -e "  ${c_bld}Actions${c_off}"
    echo -e "    ${c_grn}${c_bld}i${c_off}  Install / reinstall with the settings above"
    echo -e "    ${c_bld}u${c_off} Update   ${c_bld}s${c_off} Status   ${c_bld}l${c_off} Logs   ${c_bld}r${c_off} Restart   ${c_bld}c${c_off} Create admin   ${c_red}x${c_off} Uninstall   ${c_bld}q${c_off} Quit"
    echo
    local choice
    _read -r -p "$(echo -e "  ${c_bld}Select${c_off} ${c_dim}(number or letter)${c_off} ${c_cyn}❯${c_off} ")" choice
    case "$choice" in
      1) PANEL_PORT="$(ask_num "Panel port (HTTP)" "$PANEL_PORT")" ;;
      2) BUILD_FROM_SOURCE=$((1 - BUILD_FROM_SOURCE)) ;;
      i|I) echo; run_install; break ;;
      u|U) echo; update_command; press_enter ;;
      s|S) echo; status_command; press_enter ;;
      l|L) echo; logs_command ;;
      r|R) echo; restart_command; press_enter ;;
      c|C) echo; admin_create_command; press_enter ;;
      x|X) echo; uninstall_command; press_enter; status="not installed" ;;
      q|Q) echo; exit 0 ;;
      "") : ;;
      *) warn "Unknown option: '${choice}'"; sleep 1 ;;
    esac
  done
}

# ---- compose + env files ----------------------------------------------------
write_compose() {
  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  {
    echo "services:"
    echo "  ${SERVICE}:"
    if [ "$BUILD_FROM_SOURCE" = 1 ]; then
      echo "    build: ${REPO}.git#${BRANCH}"
    else
      echo "    image: ${IMAGE}"
    fi
    echo "    container_name: ${SERVICE}"
    echo "    restart: always"
    echo "    env_file: .env"
    echo "    network_mode: host"
    echo "    volumes:"
    echo "      - ${DATA_DIR}:/var/lib/pasarguard"
  } > "$COMPOSE_FILE"
}

# Keep an existing .env (it may hold the admin's DB/TLS/bot settings); only
# refresh the port. A fresh .env pins the DB into the data volume so it
# survives container recreation — the image default (./db.sqlite3) would not.
write_env() {
  if [ -f "$ENV_FILE" ]; then
    if grep -qE '^ *UVICORN_PORT *=' "$ENV_FILE"; then
      sed -i "s|^ *UVICORN_PORT *=.*|UVICORN_PORT = ${PANEL_PORT}|" "$ENV_FILE"
    else
      printf '\nUVICORN_PORT = %s\n' "$PANEL_PORT" >> "$ENV_FILE"
    fi
    return 0
  fi
  cat > "$ENV_FILE" <<EOF
## PasarGuard panel — generated by install.sh (edit freely, then: pasarguard restart)

UVICORN_HOST = "0.0.0.0"
UVICORN_PORT = ${PANEL_PORT}

## SQLite inside the data volume (survives container recreation).
## Prefer PostgreSQL/MySQL for larger deployments — see .env.example in the repo.
SQLALCHEMY_DATABASE_URL = "sqlite+aiosqlite:////var/lib/pasarguard/db.sqlite3"

## TLS (uncomment both to serve HTTPS directly; or use a reverse proxy)
# UVICORN_SSL_CERTFILE = "/var/lib/pasarguard/certs/example.com/fullchain.pem"
# UVICORN_SSL_KEYFILE  = "/var/lib/pasarguard/certs/example.com/key.pem"
EOF
}

# Install this script as the `pasarguard` command (same UX as upstream).
# Under `bash -c "$(curl …)"` $0 is "bash", so fall back to fetching from the repo.
install_script() {
  if [ -f "$0" ] && [[ "$(basename "$0")" == *.sh ]]; then
    install -m 0755 "$0" "$BIN_LINK"
  else
    curl -fsSL "${REPO}/raw/${BRANCH}/scripts/install.sh" -o "$BIN_LINK" && chmod 0755 "$BIN_LINK"
  fi
}

compose_up()   { dc up -d $([ "$BUILD_FROM_SOURCE" = 1 ] && echo --build); }
pull_image()   { dc pull; }

# Wait for the panel to answer HTTP (migrations run first on cold start).
wait_for_panel() {
  local i
  for i in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:${PANEL_PORT}/" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

admin_create_command() {
  require_root; need_compose || return 0
  if [ ! -e /dev/tty ] && [ ! -t 0 ]; then
    warn "no terminal — create the admin later with: pasarguard cli admin create --sudo"
    return 0
  fi
  dc exec "$SERVICE" pasarguard-cli admin create --sudo </dev/tty || \
    warn "admin creation failed/cancelled — retry with: pasarguard cli admin create --sudo"
}

print_summary() {
  local ip; ip="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || echo '<server-ip>')"
  echo; hr
  echo -e "  ${c_grn}${c_bld}PasarGuard Panel running in Docker${c_off}"
  hr
  echo -e "  Container   : ${SERVICE} ($(docker inspect -f '{{.State.Status}}' "$SERVICE" 2>/dev/null))"
  echo -e "  Dashboard   : ${c_bld}http://${ip}:${PANEL_PORT}/dashboard/${c_off}"
  echo -e "  Compose     : ${COMPOSE_FILE}"
  echo -e "  Config      : ${ENV_FILE}"
  echo -e "  Data        : ${DATA_DIR}  ${c_dim}(sqlite db, certs, templates)${c_off}"
  echo
  echo -e "  ${c_dim}Manage:${c_off} pasarguard status | logs | restart | update | cli ..."
  warn "Open port ${PANEL_PORT} on any CLOUD firewall (host networking binds it directly)."
  hr
}

run_install() {
  require_root
  : > "$STEP_LOG"
  local quiet_note=""; [ "${QUIET:-0}" = "1" ] && quiet_note=" — quiet mode"
  echo -e "${c_bld}Installing${c_off} ${c_dim}(full log: ${STEP_LOG}${quiet_note})${c_off}"
  run_step_live "Installing Docker"          install_docker
  run_step      "Writing docker-compose.yml" write_compose
  run_step      "Writing .env"               write_env
  if [ "$BUILD_FROM_SOURCE" = 0 ]; then
    if ! run_step_live_soft "Pulling image ${IMAGE}" pull_image; then
      warn "image pull failed — falling back to building from source (this takes a few minutes)"
      BUILD_FROM_SOURCE=1
      run_step "Rewriting docker-compose.yml" write_compose
    fi
  fi
  run_step_live "Starting container"         compose_up
  run_step      "Installing 'pasarguard' command" install_script
  if ! run_step_soft "Waiting for the panel to come up" wait_for_panel; then
    warn "panel didn't answer on port ${PANEL_PORT} yet — check: pasarguard logs"
  fi
  print_summary
  if [ "$ASSUME_YES" -eq 0 ] && { [ -e /dev/tty ] || [ -t 0 ]; }; then
    if ask_yn "Create the first sudo admin now?"; then admin_create_command; fi
  else
    log "Create the first sudo admin with: pasarguard cli admin create --sudo"
  fi
}

install_command() {
  parse_install_args "$@"
  require_root
  if [ "$ASSUME_YES" -eq 1 ]; then run_install; else menu_command; fi
}

update_command() {
  require_root; detect_compose || install_docker
  [ -f "$COMPOSE_FILE" ] || die "no install found at $COMPOSE_FILE"
  : > "$STEP_LOG"
  echo -e "${c_bld}Updating${c_off}"
  if grep -q "build:" "$COMPOSE_FILE"; then
    run_step_live "Rebuilding image" bash -c "cd '$INSTALL_DIR' && $COMPOSE_CMD build --pull"
  else
    run_step_live "Pulling latest image" pull_image
  fi
  run_step_live "Recreating container" bash -c "cd '$INSTALL_DIR' && $COMPOSE_CMD up -d"
  log "Updated ($(docker inspect -f '{{.State.Status}}' "$SERVICE" 2>/dev/null))"
}

need_compose() { detect_compose || { warn "Docker / compose not found — install first."; return 1; }; [ -f "$COMPOSE_FILE" ] || { warn "no install found at $COMPOSE_FILE"; return 1; }; }
restart_command()  { require_root; need_compose || return 0; dc restart; log "restarted"; }
status_command()   { need_compose || return 0; dc ps; }
logs_command()     { need_compose || return 0; dc logs -f; }
cli_command()      { require_root; need_compose || return 0; dc exec "$SERVICE" pasarguard-cli "$@"; }
uninstall_command() {
  require_root; detect_compose || true
  warn "Removing the PasarGuard Panel container"
  [ -f "$COMPOSE_FILE" ] && dc down 2>/dev/null || docker rm -f "$SERVICE" 2>/dev/null || true
  rm -f "$COMPOSE_FILE"
  rm -f "$BIN_LINK"
  if ask_yn "Also remove data (database + certs) in $DATA_DIR?"; then rm -rf "$DATA_DIR"; fi
  log "Uninstalled"
}

main() {
  local cmd="menu"
  case "${1:-}" in
    menu) cmd="menu"; shift ;;
    install|update|uninstall|restart|status|logs|cli) cmd="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
    "") cmd="menu" ;;
    -*) cmd="install" ;;
    *) die "unknown command: $1 (see --help)" ;;
  esac
  case "$cmd" in
    menu)      menu_command ;;
    install)   install_command "$@" ;;
    update)    update_command ;;
    uninstall) uninstall_command ;;
    restart)   restart_command ;;
    status)    status_command ;;
    logs)      logs_command ;;
    cli)       cli_command "$@" ;;
  esac
}

main "$@"
