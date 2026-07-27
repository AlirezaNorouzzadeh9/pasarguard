"""L2TP/IPsec helpers bridging panel settings to core configs.

The IPsec layer uses a shared pre-shared key (PSK); the L2TP/PPP layer uses
per-user username/password (reusing the IKEv2 proxy credentials, see
:mod:`app.core.l2tp`). There is no PKI, so provisioning only generates the PSK.
"""

from __future__ import annotations

import secrets
import string
from typing import Iterable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.manager import core_manager

_PSK_ALPHABET = string.ascii_letters + string.digits


def _random_psk(length: int = 12) -> str:
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


async def get_l2tp_tags(tags: Iterable[str]) -> list[str]:
    """Filter a list of inbound tags down to the L2TP ones."""
    inbounds_by_tag = await core_manager.get_inbounds_by_tag()
    result: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag in seen:
            continue
        if inbounds_by_tag.get(tag, {}).get("protocol") == "l2tp":
            seen.add(tag)
            result.append(tag)
    return result


async def get_l2tp_tags_from_groups(groups: Iterable) -> list[str]:
    """Return L2TP inbound tags reachable through the given (enabled) groups."""
    tags: list[str] = []
    for group in groups:
        if getattr(group, "is_disabled", False):
            continue
        if hasattr(group, "awaitable_attrs"):
            await group.awaitable_attrs.inbounds
        tags.extend(inbound.tag for inbound in group.inbounds)
    return await get_l2tp_tags(tags)
