<h1 align="center">PasarGuard — WireGuard &amp; OpenVPN fork</h1>

<p align="center">
  A fork of <a href="https://github.com/PasarGuard/panel">PasarGuard/panel</a> that runs
  WireGuard and OpenVPN alongside Xray, several cores per node.
</p>

<p align="center">
  <a href="https://github.com/AlirezaNorouzzadeh9/pasarguard/actions/workflows/build-fork.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/AlirezaNorouzzadeh9/pasarguard/build-fork.yml?style=flat-square&label=image" />
  </a>
  <a href="https://github.com/AlirezaNorouzzadeh9/pasarguard/pkgs/container/pasarguard">
    <img src="https://img.shields.io/badge/ghcr.io-pasarguard-blue?style=flat-square&logo=docker" />
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/github/license/AlirezaNorouzzadeh9/pasarguard?style=flat-square" />
  </a>
</p>

<p align="center"><a href="./README-fa.md">🇮🇷 فارسی</a></p>

---

## What this fork adds

**Several cores on one node.** A node can run an Xray core plus any number of WireGuard and
OpenVPN cores at once. Xray still gets a single instance — one process serves all its inbounds —
but WireGuard and OpenVPN are keyed per instance, so `wg-de` and `wg-us` coexist on one machine.

**An OpenVPN core, end to end.** The panel is the CA: it mints its own CA, server certificate and
`tls-crypt` key on first use, and issues a per-user client certificate the first time that user
fetches their subscription. Users authenticate by certificate CN and serial, so revoking one does
not disturb the rest. One core can serve UDP and TCP on the same port by declaring two listeners;
the node runs one OpenVPN process per listener and splits the subnet between them.

**A subscription page that hands out real files.** WireGuard peers download a ready `.conf` with a
QR code, OpenVPN users download a ready `.ovpn`. Both are generated per host.

**Its own installer**, forked from [PasarGuard/scripts](https://github.com/PasarGuard/scripts) and
pointed at this repository and image, with fixes for servers that are not dedicated to the panel.

---

## Install

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh)" @ install --database mariadb
```

The installer pulls `ghcr.io/alirezanorouzzadeh9/pasarguard:latest`, writes `/opt/pasarguard`,
and installs itself as the `pasarguard` command.

### Choosing a database

| `--database` | Admin UI on :8010 | Use it when |
|---|---|---|
| `mariadb` | phpMyAdmin | The default choice, and what to use if you are migrating from a MySQL/MariaDB panel |
| `mysql` | phpMyAdmin | You specifically need MySQL semantics |
| `postgresql` | pgAdmin | You prefer Postgres; pgbouncer is included |
| `timescaledb` | pgAdmin | You want node usage statistics recorded over time |
| `sqlite` | — | Trying things out. No separate database container |

Node usage statistics (`ENABLE_RECORDING_NODES_STATS`) only work on PostgreSQL/TimescaleDB.

**Match the engine you are migrating from.** A dump from MariaDB 11.4+ uses the
`utf8mb4_0900_ai_ci` collation, and an older server does not reject it — it imports with mangled
text. If your existing panel runs MariaDB, install with `--database mariadb`.

### Other flags

| Flag | Effect |
|---|---|
| `--version v1.2.3` | Install a specific image tag instead of `latest` |
| `--pre-release` | Allow pre-release versions |
| `--dev` | Install from the development image |
| `--ssl-domain example.com` | Issue a Let's Encrypt certificate for this domain during install |
| `--no-ssl` | Skip certificate setup — see the TLS note below |

Let's Encrypt uses acme.sh in standalone mode, which needs **port 80 free and reachable**. On a
server already running a web server, stop it for the duration or configure TLS afterwards.

---

## After installing

### Create the first admin

```bash
pasarguard cli admin create --sudo
```

Not needed if you restored a backup — its admins come with it.

### The panel will not listen publicly without TLS

With no certificate configured the panel binds `localhost` only and says so in its log. This is
deliberate: subscription links served over plaintext are not safe. Point it at a certificate:

```bash
pasarguard edit-env
```

```ini
UVICORN_SSL_CERTFILE = "/var/lib/pasarguard/certs/example.com/fullchain.pem"
UVICORN_SSL_KEYFILE  = "/var/lib/pasarguard/certs/example.com/key.pem"
UVICORN_SSL_CA_TYPE  = "public"
```

Then `pasarguard restart`. For a **self-signed** certificate `UVICORN_SSL_CA_TYPE` must be
`private`, or the panel rejects its own certificate for not coming from a trusted CA. The
alternative is to leave the panel on loopback and put nginx or Caddy in front of it.

---

## Backup and restore

### Taking a backup

```bash
pasarguard backup
```

Writes an archive into `/opt/pasarguard/backup/`, which is the same directory `restore` reads.

`pasarguard backup-service` sets up recurring backups delivered to Telegram.

### Restoring one this installer made

```bash
pasarguard restore
```

It lists the archives in `/opt/pasarguard/backup/` and asks which to use. It does not take a file
path.

### Restoring a dump from somewhere else

`restore` expects an archive containing a file named **`db_backup.sql`** at its top level. A bare
`.sql` or `.sql.gz` from `mysqldump` is found but then rejected, so repackage it first:

```bash
mkdir -p /opt/pasarguard/backup && rm -rf /tmp/pgbk && mkdir /tmp/pgbk && cp /root/your-dump.sql /tmp/pgbk/db_backup.sql && tar czf /opt/pasarguard/backup/imported.tar.gz -C /tmp/pgbk db_backup.sql && rm -rf /tmp/pgbk && pasarguard restore
```

If the dump is gzipped, replace the `cp` with `gunzip -c /root/your-dump.sql.gz > /tmp/pgbk/db_backup.sql`.

Schema migrations run automatically when the panel starts, so a dump from an older version is
brought up to date without extra steps.

### Two things a database backup does not carry

**Certificate files.** An Xray config that references certificates by path needs those files on
disk. Without them Xray refuses to load the *entire* core, every inbound in it disappears, and the
hosts pointing at those inbounds are left orphaned. Copy `/var/lib/pasarguard/certs/` across
separately.

**Node reachability.** Every node in a backup keeps the status it had. Restore a backup whose
nodes are `connected` and the panel will connect to them the moment it starts — if the panel that
backup came from is still running, both will fight over the same nodes and users will drop. To
restore a copy for testing, disable the nodes between importing and starting:

```bash
cd /opt/pasarguard && RP=$(grep '^MYSQL_ROOT_PASSWORD' .env | cut -d= -f2- | tr -d '"') && DB=$(grep '^DB_NAME' .env | cut -d= -f2- | tr -d '"') && docker exec -i pasarguard-mariadb-1 mariadb -uroot -p"$RP" -D "$DB" -e "UPDATE nodes SET status='disabled';"
```

---

## Commands

| | |
|---|---|
| `install` `update` `uninstall` | Lifecycle. `update` pulls the newest image and recreates |
| `up` `down` `restart` `status` | Control and inspect the stack |
| `logs` | Follow the panel log |
| `cli` `tui` | The panel's own CLI and terminal UI |
| `backup` `backup-service` `restore` | As above |
| `core-update` | Update the Xray core binary |
| `edit` `edit-env` | Open `docker-compose.yml` or `.env` in an editor |
| `install-node` | Install a node on this machine |
| `install-script` `completion` | Reinstall the command itself, or shell completion |

---

## Troubleshooting

**`Access denied for user 'pasarguard'`, restarting forever.** The database directory survived an
earlier install. The MariaDB entrypoint only creates the user when the directory is empty, so it
kept the old password while the reinstall generated a new one. Either restore the old password
into `.env`, or reset the account inside the database. `pasarguard uninstall` asks whether to
delete the data — answering no is what leaves the directory behind.

**`port 3306 is already in use`.** Only on very old copies of this installer. Current versions
step to the next free port and record it as `DB_HOST_PORT`; the database still binds `127.0.0.1`,
only the port number moves.

**The panel starts but nothing answers from outside.** It is bound to localhost because no TLS
certificate is configured. See the TLS note above — the log says this explicitly.

**Hosts show an empty inbound and the Xray section is empty.** The Xray core failed to load.
Usually a certificate file referenced by the config is missing:

```bash
docker logs pasarguard-pasarguard-1 2>&1 | grep -iE 'cert|core' | tail
```

**A WireGuard core will not start: "public key is assigned to multiple users".** Two users share a
keypair, and a node refuses the whole core rather than serve peers it cannot tell apart. Panels
that predate WireGuard support can carry duplicates, because the uniqueness check only runs for
users whose group already has WireGuard access. Compare user count with distinct key count before
enabling a WireGuard core on real data.

**WireGuard clients connect but only some sites work.** Usually a missing `DNS` line in the
generated `.conf`, not MTU. DNS is set per host under `wireguard_overrides`.

---

## Upstream

This is a fork, not a replacement. Everything upstream documents about users, groups, templates,
the API and the Telegram bot applies here — see [the PasarGuard docs](https://docs.pasarguard.org)
and [PasarGuard/panel](https://github.com/PasarGuard/panel).

Licensed under [AGPL-3.0](./LICENSE), same as upstream.
