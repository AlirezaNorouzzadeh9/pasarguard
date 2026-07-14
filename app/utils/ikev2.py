"""IKEv2/IPsec helpers bridging the panel PKI/settings to core configs and users.

Auth is EAP-MSCHAPv2 (username/password); there is no per-user PKI. The node
presents a shared server certificate issued from the panel-wide CA (the same CA
used for OpenVPN). Per-user provisioning only allocates a username (= user id)
and a random password.
"""

from __future__ import annotations

import secrets
import string
from typing import Iterable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.manager import core_manager
from app.models.proxy import ProxyTable
from app.utils import openvpn_pki
from app.utils.openvpn import ensure_openvpn_ca

_PASSWORD_ALPHABET = string.ascii_letters + string.digits


def _random_password(length: int = 16) -> str:
    return "".join(secrets.choice(_PASSWORD_ALPHABET) for _ in range(length))


async def ensure_ikev2_core_material(db: AsyncSession, config: dict) -> dict:
    """Fill in server certificate material for an IKEv2 core config.

    Reuses the panel-wide CA and issues a server certificate whose SAN carries
    the core identity. Idempotent — existing material is kept.
    """
    config = dict(config)

    # Externally-provided certificate material (e.g. a public Let's Encrypt cert
    # so native clients connect with no CA install) is kept exactly as given.
    if config.get("server_cert") and config.get("server_key") and config.get("ca_cert"):
        return config

    ca = await ensure_openvpn_ca(db)

    config["ca_cert"] = ca["ca_cert"]

    if not config.get("server_cert") or not config.get("server_key"):
        identity = str(config.get("identity") or config.get("server_addr") or "ikev2-server").strip()
        server_cert, server_key = openvpn_pki.issue_ikev2_server_cert(ca["ca_cert"], ca["ca_key"], identity)
        config["server_cert"] = server_cert
        config["server_key"] = server_key

    return config


async def get_ikev2_tags(tags: Iterable[str]) -> list[str]:
    """Filter a list of inbound tags down to the IKEv2 ones."""
    inbounds_by_tag = await core_manager.get_inbounds_by_tag()
    result: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag in seen:
            continue
        if inbounds_by_tag.get(tag, {}).get("protocol") == "ikev2":
            seen.add(tag)
            result.append(tag)
    return result


async def get_ikev2_tags_from_groups(groups: Iterable) -> list[str]:
    """Return IKEv2 inbound tags reachable through the given (enabled) groups."""
    tags: list[str] = []
    for group in groups:
        if getattr(group, "is_disabled", False):
            continue
        if hasattr(group, "awaitable_attrs"):
            await group.awaitable_attrs.inbounds
        tags.extend(inbound.tag for inbound in group.inbounds)
    return await get_ikev2_tags(tags)


async def prepare_ikev2_proxy_settings(
    db: AsyncSession,
    proxy_settings: ProxyTable,
    groups: Iterable,
    user_id: int,
    *,
    force_reissue: bool = False,
) -> ProxyTable:
    """Allocate the user's IKEv2 EAP credentials when needed.

    The username is ``str(user_id)`` (matched by the node as the EAP identity and
    used as the usage/stats key). A no-op unless the user belongs to an IKEv2
    group. ``force_reissue`` rotates the password (revoking the old profile).
    """
    from config import ikev2_env_settings

    if not ikev2_env_settings.enabled:
        return proxy_settings

    tags = await get_ikev2_tags_from_groups(groups)
    if not tags:
        return proxy_settings

    ik = proxy_settings.ikev2
    if not force_reissue and ik.username and ik.password:
        return proxy_settings

    ik.username = str(user_id)
    if force_reissue or not ik.password:
        ik.password = _random_password()
    return proxy_settings
