#!/usr/bin/env bash
# Back-compat shim: the panel now installs with the official-style PasarGuard
# CLI (scripts/pasarguard.sh). Anyone still curling this file gets forwarded.
set -e
REPO="AlirezaNorouzzadeh9/pasarguard"
exec bash -c "$(curl -fsSL https://github.com/${REPO}/raw/main/scripts/pasarguard.sh)" @ install "$@"
