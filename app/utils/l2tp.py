"""L2TP/IPsec helpers bridging panel settings to core configs.

The IPsec layer uses a shared pre-shared key (PSK); the L2TP/PPP layer uses
per-user username/password stored under the proxy table's ``ikev2`` key (see
:mod:`app.core.l2tp`). There is no PKI, so provisioning generates the PSK and
the per-user password.
"""

from __future__ import annotations

import secrets
import string
from collections.abc import Iterable
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.manager import core_manager

if TYPE_CHECKING:
    from app.models.proxy import ProxyTable

_PSK_ALPHABET = string.ascii_letters + string.digits

# The IPsec PSK cannot be per-user: charon authenticates the transport SA by the
# node's own IP, before the L2TP/PPP layer names the user (iOS/Android dial in
# main mode). So it is necessarily shared across a core's users. This deployment
# wants one fixed value across every core so the app can carry a single secret;
# an operator can still override it per core by sending an explicit `psk`.
_DEFAULT_PSK = "2000"


def _random_password(length: int = 8) -> str:
    # 8 alphanumerics on purpose: these get typed by hand into phone dialogs
    return "".join(secrets.choice(_PSK_ALPHABET) for _ in range(length))


async def ensure_l2tp_core_material(db: AsyncSession, config: dict) -> dict:
    """Fill in the shared IPsec PSK for an L2TP core config.

    Idempotent — an existing (or operator-supplied) PSK is kept as-is; a missing
    one falls back to the deployment-wide default. ``db`` is unused today but
    kept for signature parity with the other ``ensure_*_core_material`` helpers.
    """
    config = dict(config)
    if not str(config.get("psk") or "").strip():
        config["psk"] = _DEFAULT_PSK
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


async def prepare_l2tp_proxy_settings(
    db: AsyncSession,
    proxy_settings: ProxyTable,
    groups: Iterable,
    user_id: int,
    *,
    force_reissue: bool = False,
) -> ProxyTable:
    """Allocate the user's L2TP/PPP credentials when needed.

    Before the ikev2/l2tp drop this lived in ``app.utils.ikev2`` and was gated
    on IKEv2 groups; with only L2TP restored, the gate is L2TP groups and the
    env switch is gone, but the credential keeps its ``ikev2`` slot in the
    proxy table because that is the key existing data uses. The username is
    ``str(user_id)`` (the node's stats key); ``force_reissue`` rotates the
    password so previously handed-out credentials are denied.
    """
    tags = await get_l2tp_tags_from_groups(groups)
    if not tags:
        return proxy_settings

    ik = proxy_settings.ikev2
    if not force_reissue and ik.username and ik.password:
        return proxy_settings

    ik.username = str(user_id)
    if force_reissue or not ik.password:
        ik.password = _random_password()
    return proxy_settings
