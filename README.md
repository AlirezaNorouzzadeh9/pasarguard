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

Upstream runs one core per node and speaks Xray. This fork keeps all of that and adds:

**Several cores on one node.** A node can run an Xray core plus any number of WireGuard and
OpenVPN cores at the same time. Xray still gets one instance — a single process serves all its
inbounds — but WireGuard and OpenVPN are keyed per instance, so `wg-de` and `wg-us` coexist on
the same machine.

**An OpenVPN core, end to end.** The panel acts as the CA: it mints its own CA, server
certificate and `tls-crypt` key on first use, and issues a per-user client certificate the first
time that user fetches their subscription. Users authenticate by certificate CN and serial, so
revoking one user does not disturb the rest. A core can serve UDP and TCP on the same port by
declaring two listeners; the node runs one OpenVPN process per listener and splits the subnet
between them.

**A subscription page that hands out real files.** WireGuard peers download a ready `.conf`
(with QR), OpenVPN users download a ready `.ovpn`. Both are generated per host, so a user with
three WireGuard locations gets three files.

**An installer of its own.** `scripts/pasarguard.sh` is a fork of
[PasarGuard/scripts](https://github.com/PasarGuard/scripts) pointing at this repository and its
image, with fixes for servers that are not dedicated to the panel — see below.

## Install

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/AlirezaNorouzzadeh9/pasarguard/main/scripts/pasarguard.sh)" @ install --database mariadb
```

`--database` takes `mariadb`, `mysql`, `postgresql`, `timescaledb` or `sqlite`. The same command
set as upstream is available afterwards: `update`, `restart`, `status`, `logs`, `cli`, `tui`,
`backup`, `restore`, `install-node`, `uninstall`.

The image is published to GHCR on every push to `main`:

```
ghcr.io/alirezanorouzzadeh9/pasarguard:latest
```

## Things worth knowing before you deploy

**The panel will not listen publicly without TLS.** With no certificate configured it binds
localhost only and says so in its log — plaintext subscription links are not safe to serve. Point
`UVICORN_SSL_CERTFILE` / `UVICORN_SSL_KEYFILE` at a certificate, or put a reverse proxy in front.
For a self-signed pair, `UVICORN_SSL_CA_TYPE` must be `private` or the panel rejects its own
certificate.

**The database container joins the host network.** On a server already running MariaDB or
PostgreSQL for something else, the installer steps to the next free port and records it as
`DB_HOST_PORT`. Only the port moves; the database still binds `127.0.0.1`.

**A WireGuard core's peers come from its own subnet.** Widening the subnet is safe. Moving or
narrowing it invalidates configs already handed out, because peer addresses were allocated from
the old range.

**Duplicate WireGuard keys disable the whole core.** A node refuses a core when two users share a
public key — it cannot attribute traffic or enforce limits on either. Panels that predate
WireGuard support can carry duplicates from before the uniqueness check applied; check with
`SELECT COUNT(*), COUNT(DISTINCT ...) FROM users` before enabling a WireGuard core on real data.

**Certificate files are not in database backups.** An Xray config that references certificates by
path needs those files present, or Xray refuses to load the entire core and every inbound in it
goes missing. Copy `/var/lib/pasarguard/certs/` across when you move a panel.

## Upstream

This is a fork, not a replacement. Everything upstream documents about users, groups, templates,
the API and the Telegram bot applies here — see
[the PasarGuard docs](https://docs.pasarguard.org) and
[PasarGuard/panel](https://github.com/PasarGuard/panel).

Licensed under [AGPL-3.0](./LICENSE), same as upstream.
