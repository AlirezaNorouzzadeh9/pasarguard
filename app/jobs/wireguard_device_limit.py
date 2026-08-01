"""Enforce a user's device limit for WireGuard across nodes.

Every other protocol enforces this on the node itself, because everything it
needs is local: OpenVPN counts sessions, IKEv2 counts security associations,
Xray counts connections. WireGuard cannot. A peer is one key, and a key holds
exactly one endpoint per interface — so a node never sees more than one
WireGuard device per user, no matter how many the user is actually running. Put
the same key on a second node and the two kernels know nothing of each other:
the user gets one more device per location, and every node still counts one.

The only place that can see the whole picture is the panel, so the count is done
here: how many nodes is this user's WireGuard peer live on right now? Over the
limit, the peer is dropped from the most recently active nodes and restored
after a cooldown.

Two things this deliberately does *not* do:

Counting distinct addresses would be wrong. Clients arriving through a relay all
share the relay's address, so every node reports the same IP and the total
collapses to one. Nodes are counted instead — one WireGuard device per node is
exactly what the protocol allows.

Enforcement is after the fact, not at connect time. The user gets a few seconds
of traffic before being dropped. That is inherent: the decision needs data only
the panel has, and the panel is not in the data path.
"""


import time

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app import scheduler
from app.db import GetDB
from app.db.models import User
from app.models.user import UserStatus
from app.node import node_manager
from app.node.user import _serialize_user_for_node, serialize_user
from app.operation import OperatorType
from app.operation.node import NodeOperation
from app.utils.logger import get_logger
from config import job_settings, runtime_settings

logger = get_logger("wg-device-limit")

# node_id -> unix ts when the peer may be restored there, keyed by user id.
_suspended: dict[int, dict[int, float]] = {}

_node_operation = NodeOperation(OperatorType.SYSTEM)


def _wireguard_node_ids(ip_lists) -> dict[int, int]:
    """Nodes where this user currently has a live WireGuard peer.

    Returns node_id -> most recent activity timestamp, so the caller can drop
    the newest connections first and leave someone mid-session alone.
    """
    active: dict[int, int] = {}
    for node_id, entry in (ip_lists.nodes or {}).items():
        if entry is None:
            continue
        newest = 0
        for ip, last_seen in (entry.ips or {}).items():
            if (entry.ip_protocol or {}).get(ip) != "wg":
                continue
            newest = max(newest, int(last_seen or 0))
        if newest:
            active[node_id] = newest
    return active


async def _apply(user: User, node_id: int, *, remove: bool) -> bool:
    node = await node_manager.get_node(node_id)
    if node is None:
        return False
    try:
        if remove:
            # No inbounds means "forget this user", which drops the peer from
            # the interface without touching the user anywhere else.
            proto = _serialize_user_for_node(user.id, user.proxy_settings)
        else:
            proto = await serialize_user(user)
        await node.update_user(proto)
        return True
    except Exception as e:
        logger.error("node %s: could not %s user %s: %s", node_id, "drop" if remove else "restore", user.id, e)
        return False


async def _restore_expired(user: User, now: float) -> None:
    pending = _suspended.get(user.id)
    if not pending:
        return
    for node_id, until in list(pending.items()):
        if now < until:
            continue
        if await _apply(user, node_id, remove=False):
            logger.info("restored wireguard peer for user %s on node %s", user.id, node_id)
        pending.pop(node_id, None)
    if not pending:
        _suspended.pop(user.id, None)


async def _enforce_for_user(db, user: User, now: float) -> None:
    await _restore_expired(user, now)

    limit = user.ip_limit or 0
    if limit <= 0:
        return

    try:
        ip_lists = await _node_operation.get_user_ip_list_all_nodes(db, user.id)
    except Exception as e:
        logger.error("could not read online peers for user %s: %s", user.id, e)
        return
    active = _wireguard_node_ids(ip_lists)

    # A node the peer was just dropped from may still report stale activity;
    # it is not a device the user can currently use.
    suspended = _suspended.get(user.id, {})
    active = {nid: ts for nid, ts in active.items() if nid not in suspended}

    if len(active) <= limit:
        return

    # Keep the oldest sessions: whoever has been connected longest is the one
    # least likely to be a second device someone just brought online.
    ordered = sorted(active.items(), key=lambda kv: kv[1])
    cooldown = job_settings.wireguard_device_limit_cooldown
    for node_id, _ in ordered[limit:]:
        if await _apply(user, node_id, remove=True):
            _suspended.setdefault(user.id, {})[node_id] = now + cooldown
            logger.info(
                "user %s over wireguard device limit (%d nodes > %d), dropped on node %s for %ss",
                user.id,
                len(active),
                limit,
                node_id,
                cooldown,
            )


async def enforce_wireguard_device_limits() -> None:
    async with GetDB() as db:
        stmt = (
            select(User)
            .where(User.ip_limit > 0, User.status == UserStatus.active)
            .options(selectinload(User.groups))
        )
        users = (await db.execute(stmt)).scalars().all()
        if not users:
            return

        now = time.time()
        # Sequential rather than gathered: these share one session, and the
        # work is a handful of small RPCs per user.
        for user in users:
            try:
                await _enforce_for_user(db, user, now)
            except Exception as e:
                logger.error("device-limit check failed for user %s: %s", user.id, e)


if runtime_settings.role.runs_node:
    scheduler.add_job(
        enforce_wireguard_device_limits,
        "interval",
        seconds=job_settings.wireguard_device_limit_interval,
        coalesce=True,
        max_instances=1,
        id="enforce_wireguard_device_limits",
        replace_existing=True,
    )
