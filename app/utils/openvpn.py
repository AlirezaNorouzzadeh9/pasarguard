"""OpenVPN helpers bridging the panel settings/PKI to core configs and users.

Unlike WireGuard there is no IP pool to manage: OpenVPN assigns client IPs from
its own server subnet. This module only manages certificate material.
"""

from __future__ import annotations

from typing import Iterable

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.manager import core_manager
from app.db.crud.settings import get_settings
from app.models.proxy import ProxyTable
from app.utils import openvpn_pki


async def _persist_openvpn_settings(db: AsyncSession, openvpn: dict) -> None:
    db_settings = await get_settings(db)
    db_settings.openvpn = openvpn
    await db.commit()
    await db.refresh(db_settings)
    # Avoid a circular import at module load; refresh the cached accessor.
    # ``.cache`` is absent when caching is disabled (e.g. tests) — guard it.
    from app.settings import openvpn_settings

    cache = getattr(openvpn_settings, "cache", None)
    if cache is not None:
        await cache.clear()


async def ensure_openvpn_ca(db: AsyncSession) -> dict:
    """Return the panel OpenVPN CA material, generating and persisting it on first use.

    Returns a dict with keys ``ca_cert``, ``ca_key``, ``tls_crypt_key`` and
    ``client_cert_validity_days``.
    """
    db_settings = await get_settings(db)
    openvpn = dict(db_settings.openvpn or {})

    changed = False
    if not openvpn.get("ca_cert") or not openvpn.get("ca_key"):
        ca_cert, ca_key = openvpn_pki.generate_ca()
        openvpn["ca_cert"] = ca_cert
        openvpn["ca_key"] = ca_key
        changed = True
    if not openvpn.get("tls_crypt_key"):
        openvpn["tls_crypt_key"] = openvpn_pki.generate_tls_crypt_key()
        changed = True
    openvpn.setdefault("client_cert_validity_days", 3650)

    if changed:
        await _persist_openvpn_settings(db, openvpn)

    return openvpn


async def ensure_openvpn_core_material(db: AsyncSession, config: dict) -> dict:
    """Fill in server certificate material for an OpenVPN core config.

    Issues a server cert/key from the panel CA and embeds the CA cert and shared
    tls-crypt key if any are missing. Idempotent — existing material is kept.
    """
    config = dict(config)
    ca = await ensure_openvpn_ca(db)

    config["ca_cert"] = ca["ca_cert"]
    config["tls_crypt_key"] = config.get("tls_crypt_key") or ca["tls_crypt_key"]

    if not config.get("server_cert") or not config.get("server_key"):
        cn = str(config.get("inbound_tag") or "openvpn-server")
        server_cert, server_key = openvpn_pki.issue_server_cert(ca["ca_cert"], ca["ca_key"], cn)
        config["server_cert"] = server_cert
        config["server_key"] = server_key

    return config


async def get_openvpn_tags(tags: Iterable[str]) -> list[str]:
    """Filter a list of inbound tags down to the OpenVPN ones."""
    inbounds_by_tag = await core_manager.get_inbounds_by_tag()
    result: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag in seen:
            continue
        if inbounds_by_tag.get(tag, {}).get("protocol") == "openvpn":
            seen.add(tag)
            result.append(tag)
    return result


async def get_openvpn_tags_from_groups(groups: Iterable) -> list[str]:
    """Return OpenVPN inbound tags reachable through the given (enabled) groups."""
    tags: list[str] = []
    for group in groups:
        if getattr(group, "is_disabled", False):
            continue
        if hasattr(group, "awaitable_attrs"):
            await group.awaitable_attrs.inbounds
        tags.extend(inbound.tag for inbound in group.inbounds)
    return await get_openvpn_tags(tags)


async def prepare_openvpn_proxy_settings(
    db: AsyncSession,
    proxy_settings: ProxyTable,
    groups: Iterable,
    user_id: int,
    *,
    force_reissue: bool = False,
) -> ProxyTable:
    """Issue or renew the user's OpenVPN client certificate when needed.

    The certificate CN is ``str(user_id)`` — matched by the node against the
    synced user list. A no-op unless the user belongs to an OpenVPN group.
    Renewal/reissue produces a fresh serial so the node denies the old cert.
    """
    from config import openvpn_env_settings

    if not openvpn_env_settings.enabled:
        return proxy_settings

    tags = await get_openvpn_tags_from_groups(groups)
    if not tags:
        return proxy_settings

    ov = proxy_settings.openvpn
    if not force_reissue and not openvpn_pki.cert_needs_renewal(ov.cert_pem):
        return proxy_settings

    ca = await ensure_openvpn_ca(db)
    cert = openvpn_pki.issue_client_cert(
        ca["ca_cert"],
        ca["ca_key"],
        str(user_id),
        days=int(ca.get("client_cert_validity_days") or 3650),
    )
    ov.cert_pem = cert.cert_pem
    ov.private_key_pem = cert.key_pem
    ov.serial = cert.serial
    ov.fingerprint = cert.fingerprint
    ov.not_after = cert.not_after.isoformat()
    return proxy_settings
