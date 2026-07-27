"""L2TP/IPsec helpers bridging panel settings to core configs.

The IPsec layer uses a shared pre-shared key (PSK); the L2TP/PPP layer uses
per-user username/password (reusing the IKEv2 proxy credentials, see
:mod:`app.core.l2tp`). There is no PKI, so provisioning only generates the PSK.
"""

from __future__ import annotations

import secrets
import string

from sqlalchemy.ext.asyncio import AsyncSession

_PSK_ALPHABET = string.ascii_letters + string.digits


def _random_psk(length: int = 32) -> str:
    return "".join(secrets.choice(_PSK_ALPHABET) for _ in range(length))


async def ensure_l2tp_core_material(db: AsyncSession, config: dict) -> dict:
    """Fill in the shared IPsec PSK for an L2TP core config.

    Idempotent — an existing (or operator-supplied) PSK is kept as-is; only a
    missing one is generated. ``db`` is unused today but kept for signature
    parity with the other ``ensure_*_core_material`` helpers.
    """
    config = dict(config)
    if not str(config.get("psk") or "").strip():
        config["psk"] = _random_psk()
    return config
