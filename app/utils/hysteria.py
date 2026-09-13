from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.models.proxy import ProxyTable
from app.utils.system import random_password


async def hysteria_auth_in_use(
    db: AsyncSession,
    auth: str,
    *,
    exclude_user_id: int | None = None,
) -> bool:
    stmt = select(User.id).where(User.proxy_settings["hysteria"]["auth"].as_string() == auth).limit(1)
    if exclude_user_id is not None:
        stmt = stmt.where(User.id != exclude_user_id)
    return (await db.execute(stmt)).first() is not None


async def ensure_unique_hysteria_auth(
    db: AsyncSession,
    proxy_settings: ProxyTable,
    *,
    exclude_user_id: int | None = None,
) -> None:
    """Guarantee the hysteria2 credential does not already belong to someone else.

    This guards the same failure as the WireGuard keypair check: a client (e.g. a
    reseller bot) that sends one hardcoded value for every user it creates. It
    matters more here than anywhere else because sing-box identifies a hysteria2
    user *by this credential alone* — a shared value makes it attribute one
    person's traffic to whoever else holds the same auth, so users get billed for
    traffic they never used and their quota drains without them connecting.

    Rather than fail the create, swap in a freshly generated unique credential so
    the user is still provisioned correctly.
    """
    auth = proxy_settings.hysteria.auth
    if not auth:
        return
    if not await hysteria_auth_in_use(db, auth, exclude_user_id=exclude_user_id):
        return
    for _ in range(10):
        candidate = random_password()
        if not await hysteria_auth_in_use(db, candidate, exclude_user_id=exclude_user_id):
            proxy_settings.hysteria.auth = candidate
            return
    raise ValueError("could not generate a unique hysteria auth")
