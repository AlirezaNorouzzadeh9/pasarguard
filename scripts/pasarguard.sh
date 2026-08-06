#!/usr/bin/env bash
#
# PasarGuard fork installer and operator.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh)" @ install
#
# Deliberately not a fork of PasarGuard/scripts. That script is 2044 lines plus
# seven shared libraries and carries acme/SSL, Telegram backup, pgAdmin,
# TimescaleDB, PostgreSQL and node install — none of which this deployment uses.
# Something that runs as root out of a curl pipe should be short enough to read.
#
# The stack is MariaDB 12.3 to match the production panel being migrated from.
# That version is not cosmetic: dumps from it use utf8mb4_0900_ai_ci, which
# MariaDB below 11.4 cannot even parse, and importing one there mangles text
# rather than failing loudly.

set -euo pipefail

# Every path, port and container name is overridable. That is mostly so a
# second stack can be stood up beside a live one to rehearse a migration
# without touching it — which is exactly how this script gets tested.
APP_DIR="${APP_DIR:-/opt/pasarguard}"
DATA_DIR="${DATA_DIR:-/var/lib/pasarguard}"
DB_DIR="${DB_DIR:-/var/lib/pasarguard-db}"
BACKUP_DIR="$DATA_DIR/backups"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
ENV_FILE="$APP_DIR/.env"
SCRIPT_PATH="${SCRIPT_PATH:-/usr/local/bin/pasarguard}"
SCRIPT_URL="https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh"

PANEL_IMAGE="${PANEL_IMAGE:-ghcr.io/alirezanorouzzadeh9/pasarguard:latest}"
MARIADB_IMAGE="${MARIADB_IMAGE:-mariadb:12.3}"
PHPMYADMIN_IMAGE="${PHPMYADMIN_IMAGE:-phpmyadmin:latest}"

DB_NAME="${DB_NAME:-pasarguard}"
DB_USER="${DB_USER:-pasarguard}"
PROJECT="${PROJECT:-pasarguard}"
PANEL_CONTAINER="$PROJECT"
DB_CONTAINER="$PROJECT-mariadb"
PMA_CONTAINER="$PROJECT-phpmyadmin"
PANEL_PORT="${PANEL_PORT:-8000}"
PMA_PORT="${PMA_PORT:-8010}"
DB_PORT="${DB_PORT:-3306}"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info()  { echo "${BLUE}==>${NC} $*"; }
ok()    { echo "${GREEN} ok${NC} $*"; }
warn()  { echo "${YELLOW} !!${NC} $*"; }
die()   { echo "${RED}error:${NC} $*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run this with sudo"; }

compose() { docker compose -p "$PROJECT" --project-directory "$APP_DIR" -f "$COMPOSE_FILE" "$@"; }

# Root password lives in the compose file and nowhere else; reading it back
# beats keeping a second copy in sync. sed rather than grep -oP because -P is a
# GNU extension and this has to work wherever the panel gets installed.
db_root_pw() { sed -n 's/^[[:space:]]*MARIADB_ROOT_PASSWORD:[[:space:]]*//p' "$COMPOSE_FILE" | head -1; }
db_app_pw()  { sed -n 's/^[[:space:]]*MARIADB_PASSWORD:[[:space:]]*//p' "$COMPOSE_FILE" | head -1; }

mysql_root() { docker exec -i "$DB_CONTAINER" mariadb -uroot -p"$(db_root_pw)" "$@"; }

installed() { [ -f "$COMPOSE_FILE" ]; }
require_installed() { installed || die "not installed — run: pasarguard install"; }

# ---------------------------------------------------------------- prerequisites

install_docker() {
    if docker compose version >/dev/null 2>&1; then
        ok "docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
        return
    fi
    info "installing docker"
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 \
        || die "docker install failed — install it manually and re-run"
    docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"
    ok "docker installed"
}

install_prereqs() {
    local missing=()
    for c in curl unzip gzip; do command -v "$c" >/dev/null || missing+=("$c"); done
    [ ${#missing[@]} -eq 0 ] && return
    info "installing ${missing[*]}"
    if command -v apt-get >/dev/null; then
        apt-get update -qq && apt-get install -y -qq "${missing[@]}"
    elif command -v dnf >/dev/null; then
        dnf install -y -q "${missing[@]}"
    else
        die "install these first: ${missing[*]}"
    fi
}

port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }

# ---------------------------------------------------------------- file writing

write_compose() {
    local root_pw="$1" app_pw="$2"
    # The panel runs on the host network so it can bind whatever ports cores
    # need; it reaches the database on the published loopback port. MariaDB and
    # phpMyAdmin share a private network, which is why the database port is
    # never exposed beyond 127.0.0.1.
    cat > "$COMPOSE_FILE" <<EOF
services:
  mariadb:
    image: $MARIADB_IMAGE
    container_name: $DB_CONTAINER
    restart: always
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
      # A panel dump is one enormous multi-row INSERT per table; the 16M
      # default rejects it halfway through with a packet error.
      - --max-allowed-packet=512M
    environment:
      MARIADB_ROOT_PASSWORD: $root_pw
      MARIADB_DATABASE: $DB_NAME
      MARIADB_USER: $DB_USER
      MARIADB_PASSWORD: $app_pw
    ports:
      - "127.0.0.1:$DB_PORT:3306"
    volumes:
      - $DB_DIR:/var/lib/mysql
    networks: [$PROJECT]
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 60

  phpmyadmin:
    image: $PHPMYADMIN_IMAGE
    container_name: $PMA_CONTAINER
    restart: always
    environment:
      PMA_HOST: mariadb
      PMA_PORT: 3306
      UPLOAD_LIMIT: 2G
      MEMORY_LIMIT: 2G
      MAX_EXECUTION_TIME: 0
    ports:
      - "$PMA_PORT:80"
    networks: [$PROJECT]
    depends_on:
      mariadb:
        condition: service_healthy

  pasarguard:
    image: $PANEL_IMAGE
    container_name: $PANEL_CONTAINER
    restart: always
    env_file: .env
    network_mode: host
    volumes:
      # Host side is configurable, container side is not: the app resolves
      # templates, certs and uploads under /var/lib/pasarguard regardless of
      # where those files live on the host.
      - $DATA_DIR:/var/lib/pasarguard
    depends_on:
      mariadb:
        condition: service_healthy

networks:
  $PROJECT:
    name: $PROJECT
EOF
}

write_env() {
    local app_pw="$1"
    cat > "$ENV_FILE" <<EOF
UVICORN_HOST = "0.0.0.0"
UVICORN_PORT = $PANEL_PORT

SQLALCHEMY_DATABASE_URL = "mysql+asyncmy://$DB_USER:$app_pw@127.0.0.1:$DB_PORT/$DB_NAME"
EOF
    chmod 600 "$ENV_FILE"
}

install_self() {
    if [ -f "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "$SCRIPT_PATH" ]; then
        cp "${BASH_SOURCE[0]}" "$SCRIPT_PATH"
    else
        # Ran straight from a curl pipe, so there is no local file to copy.
        curl -fsSL "$SCRIPT_URL" -o "$SCRIPT_PATH" || return 0
    fi
    chmod +x "$SCRIPT_PATH"
}

# ---------------------------------------------------------------- waiting

wait_for_db() {
    local _
    for _ in $(seq 1 60); do
        if docker exec "$DB_CONTAINER" mariadb -uroot -p"$(db_root_pw)" \
             -e 'SELECT 1;' >/dev/null 2>&1; then
            ok "database ready"
            return 0
        fi
        sleep 3
    done
    die "database never came up — see: pasarguard logs mariadb"
}

wait_for_panel() {
    local _ code
    for _ in $(seq 1 60); do
        # TLS may or may not be configured, so try https and fall back to http.
        # Written as an if rather than `a || b && c`: that form returns non-zero
        # on the common path and would trip set -e.
        code=$(curl -sk -o /dev/null -w '%{http_code}' \
               "https://127.0.0.1:$PANEL_PORT/api/nodes" 2>/dev/null || true)
        if [ -z "$code" ] || [ "$code" = "000" ]; then
            code=$(curl -s -o /dev/null -w '%{http_code}' \
                   "http://127.0.0.1:$PANEL_PORT/api/nodes" 2>/dev/null || true)
        fi
        case "$code" in
            200|401|403) ok "panel answering (HTTP $code)"; return 0 ;;
        esac
        if [ "$(docker inspect "$PANEL_CONTAINER" --format '{{.State.Status}}' 2>/dev/null)" = "exited" ]; then
            docker logs --tail 40 "$PANEL_CONTAINER" 2>&1 || true
            die "panel exited on startup"
        fi
        sleep 3
    done
    docker logs --tail 40 "$PANEL_CONTAINER" 2>&1 || true
    die "panel never answered — see: pasarguard logs"
}

# ---------------------------------------------------------------- checks

# Everything here is read-only. It reports and never edits, because by the time
# it runs the rows are the operator's real data.
preflight() {
    local strict="${1:-}"

    echo
    info "pre-start checks"

    local ver
    ver=$(mysql_root -N -e 'SELECT VERSION();' 2>/dev/null || echo unknown)
    echo "    mariadb           $ver"

    # The trap that cost us an afternoon: a 12.x dump restored onto 10.6 does
    # not error, it silently rewrites text with the wrong collation.
    local coll
    coll=$(mysql_root -N -e "SELECT COUNT(*) FROM information_schema.COLLATIONS \
           WHERE COLLATION_NAME='utf8mb4_0900_ai_ci';" 2>/dev/null || echo 0)
    if [ "$coll" = "1" ]; then
        echo "    collation support utf8mb4_0900_ai_ci ok"
    else
        warn "this MariaDB does not know utf8mb4_0900_ai_ci"
        warn "a dump from MariaDB 11.4+ will import with mangled text"
        [ "$strict" = "strict" ] && die "refusing to import onto an incompatible server"
    fi

    local alembic
    alembic=$(mysql_root -N -D "$DB_NAME" -e 'SELECT version_num FROM alembic_version;' 2>/dev/null || echo "-")
    echo "    schema revision   ${alembic:--} (migrations run automatically on start)"

    if mysql_root -N -D "$DB_NAME" -e 'SELECT 1 FROM nodes LIMIT 1;' >/dev/null 2>&1; then
        local total live
        total=$(mysql_root -N -D "$DB_NAME" -e 'SELECT COUNT(*) FROM nodes;')
        live=$(mysql_root -N -D "$DB_NAME" -e "SELECT COUNT(*) FROM nodes WHERE status <> 'disabled';")
        echo "    nodes             $total total, $live enabled"
        if [ "${live:-0}" -gt 0 ]; then
            warn "$live node(s) will be connected as soon as the panel starts."
            warn "if the panel these nodes came from is still running, both panels"
            warn "will fight over them and your users will drop. Turn the old one"
            warn "off first, or disable nodes here before starting."
        fi
    fi

    check_certs
}

# Cert files are referenced by absolute path inside the xray config but live on
# the panel's disk, and no database dump carries them. Restore onto a fresh box
# and xray refuses to load the entire core over one missing file.
check_certs() {
    local paths missing=()
    paths=$(mysql_root -N -D "$DB_NAME" \
        -e "SELECT config FROM core_configs WHERE type='xray';" 2>/dev/null \
        | grep -oE '"(certificateFile|keyFile)"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | grep -oE '"/[^"]+"' | tr -d '"' | sort -u || true)
    [ -z "$paths" ] && return 0

    local p host_p
    while IFS= read -r p; do
        [ -z "$p" ] && continue
        # Paths in the config are container paths. They only differ from the
        # host's when DATA_DIR has been moved, but checking the wrong one would
        # report every certificate as missing.
        host_p="${p/#\/var\/lib\/pasarguard/$DATA_DIR}"
        [ -f "$host_p" ] || missing+=("$p")
    done <<< "$paths"

    if [ ${#missing[@]} -eq 0 ]; then
        echo "    tls certificates  all $(echo "$paths" | grep -c .) present"
    else
        warn "${#missing[@]} certificate file(s) referenced by the xray config are missing:"
        printf '        %s\n' "${missing[@]}"
        warn "copy them from the old panel before starting, or xray will not load."
    fi
}

# ---------------------------------------------------------------- commands

cmd_install() {
    need_root
    installed && die "already installed — use 'pasarguard update' or 'pasarguard uninstall'"

    install_prereqs
    install_docker

    for p in "$PANEL_PORT" "$PMA_PORT" "$DB_PORT"; do
        port_free "$p" || die "port $p is already in use"
    done

    mkdir -p "$APP_DIR" "$DATA_DIR" "$DB_DIR" "$BACKUP_DIR" "$DATA_DIR/certs"

    local root_pw app_pw
    root_pw=$(openssl rand -hex 20)
    app_pw=$(openssl rand -hex 20)

    info "writing $COMPOSE_FILE and $ENV_FILE"
    write_compose "$root_pw" "$app_pw"
    write_env "$app_pw"
    chmod 600 "$COMPOSE_FILE"

    info "pulling images"
    compose pull -q 2>&1 | tail -3 || true

    info "starting database"
    compose up -d mariadb phpmyadmin
    wait_for_db

    info "starting panel (migrations run now)"
    compose up -d pasarguard
    wait_for_panel

    install_self

    local ip
    ip=$(curl -fsS4 --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo
    ok "installed"
    echo
    echo "  panel        http://$ip:$PANEL_PORT"
    echo "  phpMyAdmin   http://$ip:$PMA_PORT   (user: $DB_USER, db: $DB_NAME)"
    echo "  db password  grep MARIADB_PASSWORD $COMPOSE_FILE"
    echo
    echo "  create your first admin:"
    echo "      pasarguard cli admin create --sudo"
    echo
    warn "phpMyAdmin is reachable from the internet on port $PMA_PORT."
    warn "it is there so you can import a backup. Turn it off when you are done:"
    warn "    pasarguard phpmyadmin off"
}

# Two supported routes, because they fail differently. This one streams the
# file straight into mariadb, which has no timeout or memory ceiling — the two
# things that break a 100MB+ import through phpMyAdmin.
cmd_restore() {
    need_root; require_installed
    local src="${1:-}"
    [ -n "$src" ] || die "usage: pasarguard restore <file.sql|.sql.gz|.zip>"
    [ -f "$src" ] || die "no such file: $src"

    docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || compose up -d mariadb
    wait_for_db

    local work sql
    work=$(mktemp -d)
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" EXIT

    case "$src" in
        *.zip)    info "extracting"; unzip -o -q "$src" -d "$work"
                  sql=$(find "$work" -name '*.sql' | head -1) ;;
        *.sql.gz|*.gz) info "decompressing"; gunzip -c "$src" > "$work/dump.sql"; sql="$work/dump.sql" ;;
        *.sql)    sql="$src" ;;
        *)        die "unrecognised file type: $src" ;;
    esac
    [ -n "${sql:-}" ] && [ -f "$sql" ] || die "no .sql found inside $src"
    info "dump: $(du -h "$sql" | cut -f1)"

    # Refuse rather than mangle: this is the check that would have caught the
    # 10.6 mismatch before 127MB of user data went in.
    if grep -qm1 'utf8mb4_0900' "$sql"; then
        local coll
        coll=$(mysql_root -N -e "SELECT COUNT(*) FROM information_schema.COLLATIONS \
               WHERE COLLATION_NAME='utf8mb4_0900_ai_ci';" 2>/dev/null || echo 0)
        [ "$coll" = "1" ] || die "dump uses utf8mb4_0900_ai_ci but this MariaDB \
($(mysql_root -N -e 'SELECT VERSION();')) does not support it. Importing would corrupt text."
    fi

    info "stopping panel so nothing writes during the import"
    compose stop pasarguard >/dev/null 2>&1 || true

    if mysql_root -N -D "$DB_NAME" -e 'SELECT 1;' >/dev/null 2>&1; then
        local safety
        safety="$BACKUP_DIR/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
        info "backing up the current database first"
        docker exec "$DB_CONTAINER" mariadb-dump -uroot -p"$(db_root_pw)" \
            --single-transaction --quick "$DB_NAME" 2>/dev/null | gzip > "$safety" || true
        ok "saved $safety"
    fi

    info "importing (this takes a couple of minutes)"
    mysql_root -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; \
                   CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    if ! mysql_root "$DB_NAME" < "$sql"; then
        die "import failed — the previous database is in $BACKUP_DIR"
    fi
    ok "imported"

    preflight

    echo
    info "starting panel — schema migrations run now"
    compose up -d pasarguard
    wait_for_panel

    local final
    final=$(mysql_root -N -D "$DB_NAME" -e 'SELECT version_num FROM alembic_version;' 2>/dev/null || echo '-')
    echo
    ok "restored and migrated to schema $final"
    docker logs "$PANEL_CONTAINER" 2>&1 | grep -i 'running upgrade' | tail -10 || true
}

cmd_backup() {
    need_root; require_installed
    mkdir -p "$BACKUP_DIR"
    local out
    out="$BACKUP_DIR/pasarguard-$(date +%Y%m%d-%H%M%S).sql.gz"
    info "dumping $DB_NAME"
    docker exec "$DB_CONTAINER" mariadb-dump -uroot -p"$(db_root_pw)" \
        --single-transaction --quick --routines --events "$DB_NAME" | gzip > "$out"
    ok "$out ($(du -h "$out" | cut -f1))"
    warn "this does not include $DATA_DIR/certs — copy that directory separately."
}

cmd_restart() {
    need_root; require_installed
    info "restarting"
    compose up -d mariadb phpmyadmin
    wait_for_db
    compose stop pasarguard >/dev/null 2>&1 || true
    preflight
    echo
    compose up -d pasarguard
    wait_for_panel
    local final
    final=$(mysql_root -N -D "$DB_NAME" -e 'SELECT version_num FROM alembic_version;' 2>/dev/null || echo '-')
    ok "running at schema $final"
    docker logs --since 5m "$PANEL_CONTAINER" 2>&1 | grep -i 'running upgrade' | tail -10 || true
}

cmd_update() {
    need_root; require_installed
    info "pulling $PANEL_IMAGE"
    docker pull "$PANEL_IMAGE"
    compose up -d
    wait_for_panel
    ok "updated"
}

cmd_status() {
    require_installed
    compose ps
    echo
    local alembic
    alembic=$(mysql_root -N -D "$DB_NAME" -e 'SELECT version_num FROM alembic_version;' 2>/dev/null || echo '-')
    echo "  schema revision: $alembic"
    echo "  panel image:     $(docker inspect "$PANEL_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo '-')"
}

cmd_phpmyadmin() {
    need_root; require_installed
    case "${1:-}" in
        off) compose stop phpmyadmin && ok "phpMyAdmin stopped" ;;
        on)  compose up -d phpmyadmin && ok "phpMyAdmin on port $PMA_PORT" ;;
        *)   die "usage: pasarguard phpmyadmin on|off" ;;
    esac
}

cmd_uninstall() {
    need_root; require_installed
    warn "this removes the containers and $APP_DIR."
    read -r -p "also delete the database and all user data? [y/N] " yes
    compose down --remove-orphans || true
    rm -rf "$APP_DIR"
    if [ "${yes,,}" = "y" ]; then
        rm -rf "$DB_DIR" "$DATA_DIR"
        ok "removed everything"
    else
        ok "containers removed; $DB_DIR and $DATA_DIR kept"
    fi
    rm -f "$SCRIPT_PATH"
}

usage() {
    cat <<EOF
pasarguard — install and operate the panel

  install              install docker, MariaDB, phpMyAdmin and the panel
  restore <file>       import a .sql/.sql.gz/.zip dump, then migrate and start
  backup               dump the database to $BACKUP_DIR
  restart              re-run checks, migrate and restart the panel
  update               pull the newest panel image and recreate
  status               containers, schema revision and image
  logs [service]       follow logs (default: the panel)
  cli [args...]        run the panel CLI, e.g. cli admin create --sudo
  phpmyadmin on|off    expose or hide phpMyAdmin on port $PMA_PORT
  uninstall            remove the stack

After importing a backup through phpMyAdmin, run 'pasarguard restart' — it
checks the database and applies any pending schema migrations.
EOF
}

main() {
    case "${1:-help}" in
        install)    shift; cmd_install "$@" ;;
        restore)    shift; cmd_restore "$@" ;;
        backup)     shift; cmd_backup "$@" ;;
        restart)    shift; cmd_restart "$@" ;;
        update)     shift; cmd_update "$@" ;;
        status)     shift; cmd_status "$@" ;;
        up)         need_root; require_installed; compose up -d; wait_for_panel ;;
        down)       need_root; require_installed; compose down ;;
        logs)       require_installed; docker logs -f --tail 100 \
                        "$([ "${2:-}" = "mariadb" ] && echo "$DB_CONTAINER" || echo "$PANEL_CONTAINER")" ;;
        cli)        shift; require_installed; docker exec -it "$PANEL_CONTAINER" pasarguard-cli "$@" ;;
        phpmyadmin) shift; cmd_phpmyadmin "$@" ;;
        uninstall)  shift; cmd_uninstall "$@" ;;
        help|-h|--help) usage ;;
        *)          die "unknown command: $1 (try: pasarguard help)" ;;
    esac
}

main "$@"
