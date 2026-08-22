"""Holding users to their connection limit across every node.

Each backend already enforces the limit on the node it runs on: OpenVPN refuses
the connection outright, L2TP and sing-box end the newest, xray takes the
account out of its inbounds so the next connection is refused. None of them can
see past their own node, and the limit the operator set is a total.

So the gap this closes is the one only the panel can see. A user whose limit is
1 can be inside it on node A and inside it on node B and still be connected
twice, and the two nodes will happily agree with each other. It is also the
whole of the story for WireGuard, which has no session to end and no connection
to refuse: a peer is either configured on a node or it is not.

The rule is the same as everywhere else -- the newest gives way. A node is only
suppressed when every address the user holds on it is one of the newest, so a
node still carrying an older, legitimate connection is never disturbed.
"""

import asyncio
import time

from sqlalchemy import select

from app import on_startup, scheduler
from app.db import GetDB
from app.db.models import Node, User, UserStatus
from app.node import node_manager
from app.node.user import _serialize_user_for_node, serialize_user
from app.utils.logger import get_logger
from config import job_settings, runtime_settings

logger = get_logger("ip-limit")

# Asking every node about every limited user is a fan-out, so keep it modest.
NODE_QUERY_SEM = asyncio.Semaphore(8)
NODE_QUERY_TIMEOUT = 8

# How recently a node must have seen an address for it to count as connected.
#
# The nodes answer with the last time they saw each address and never expire the
# entry, because for their own purposes -- showing an operator where a user has
# been -- there is no reason to. Counting those against a live limit means an
# address someone used yesterday still occupies a slot: a WireGuard endpoint is
# remembered for the life of the interface, and xray keeps one for minutes after
# the client has gone. Every one of those would hold a place that nobody is in.
ONLINE_WINDOW_SECONDS = 180

# When an address was first seen, per user: {user_id: {(node_id, ip): monotonic}}.
# The nodes report a last-seen timestamp, which cannot order arrivals, so the
# panel remembers first sight itself.
_first_seen: dict[int, dict[tuple[int, str], float]] = {}

# Nodes a user is currently held off: {user_id: {node_id}}.
_suppressed: dict[int, set[int]] = {}


async def _node_ips(node_id: int, email: str) -> dict[str, int] | None:
    """Where a user is connected from on one node, or None if it could not say.

    None and empty are different answers and are treated differently: a node
    that is unreachable must not look like a node the user has left, or their
    address there would be forgotten and a genuinely newer one would inherit
    its place in the ordering.
    """
    node = await node_manager.get_node(node_id)
    if node is None:
        return None
    try:
        async with NODE_QUERY_SEM:
            stats = await asyncio.wait_for(node.get_user_online_ip_list(email=email), timeout=NODE_QUERY_TIMEOUT)
    except Exception:
        return None
    if stats is None:
        return None
    return _fresh(stats.ips or {}, time.time())


def _fresh(ips: dict[str, int], now: float) -> dict[str, int]:
    """Only the addresses seen recently enough to still be someone.

    The comparison is against this panel's clock, which is the clock every
    node's freshness is judged by, so a node running fast cannot win itself
    extra slots at another node's expense.
    """
    cutoff = now - ONLINE_WINDOW_SECONDS
    return {ip: seen for ip, seen in ips.items() if seen >= cutoff}


async def _suppress(node_id: int, user: User) -> bool:
    """Take a user off one node, leaving every other node alone."""
    node = await node_manager.get_node(node_id)
    if node is None:
        return False
    # No inbounds means no access: the node drops the peer, the credential and
    # the account, exactly as it does when the panel revokes a group.
    blocked = _serialize_user_for_node(user.id, user.proxy_settings)
    try:
        await asyncio.wait_for(node.update_user(blocked), timeout=NODE_QUERY_TIMEOUT)
    except Exception as exc:
        logger.error("could not hold user %s off node %s: %s", user.id, node_id, exc)
        return False
    return True


async def _restore(node_id: int, user: User) -> bool:
    """Give a user their access on one node back."""
    node = await node_manager.get_node(node_id)
    if node is None:
        # The node is gone; there is nothing left to be held off.
        return True
    try:
        proto_user = await serialize_user(user)
        await asyncio.wait_for(node.update_user(proto_user), timeout=NODE_QUERY_TIMEOUT)
    except Exception as exc:
        logger.error("could not restore user %s on node %s: %s", user.id, node_id, exc)
        return False
    return True


def _track_addresses(user_id: int, seen: set[tuple[int, str]], now: float) -> None:
    """Record newly seen addresses and forget the ones that have gone."""
    known = _first_seen.setdefault(user_id, {})
    for address in seen:
        known.setdefault(address, now)
    for address in list(known):
        if address not in seen:
            del known[address]


def _nodes_to_suppress(user_id: int, seen: set[tuple[int, str]], limit: int) -> set[int]:
    """The nodes whose addresses are all among the newest past the limit."""
    known = _first_seen.get(user_id, {})
    ordered = sorted(seen, key=lambda address: (known.get(address, 0.0), address))
    excess = set(ordered[limit:])
    if not excess:
        return set()

    per_node: dict[int, set[tuple[int, str]]] = {}
    for address in seen:
        per_node.setdefault(address[0], set()).add(address)

    # A node keeping an older connection alive is left alone: cutting it to
    # enforce the limit would end the session that has every right to be there.
    return {node_id for node_id, addresses in per_node.items() if addresses <= excess}


async def _enforce_for_user(user: User, node_ids: list[int], now: float) -> None:
    limit = user.ip_limit or 0
    held = _suppressed.get(user.id, set())

    if limit <= 0:
        for node_id in list(held):
            if await _restore(node_id, user):
                held.discard(node_id)
        _suppressed.pop(user.id, None)
        _first_seen.pop(user.id, None)
        return

    email = str(user.id)
    # A suppressed node has nothing to report, so there is no point asking it.
    asked = [node_id for node_id in node_ids if node_id not in held]
    results = await asyncio.gather(*(_node_ips(node_id, email) for node_id in asked))

    seen: set[tuple[int, str]] = set()
    unknown: set[int] = set()
    for node_id, ips in zip(asked, results, strict=True):
        if ips is None:
            unknown.add(node_id)
            continue
        for ip in ips:
            if ip:
                seen.add((node_id, ip))

    # An unreachable node's addresses stay on the books rather than being
    # forgotten and then re-dated as new.
    kept = {address for address in _first_seen.get(user.id, {}) if address[0] in unknown}
    standing = seen | kept
    _track_addresses(user.id, standing, now)

    for node_id in _nodes_to_suppress(user.id, standing, limit):
        if node_id in held:
            continue
        if await _suppress(node_id, user):
            held.add(node_id)
            logger.info(
                "user %s is over their %d-connection limit; held off node %s",
                user.id,
                limit,
                node_id,
            )

    # Restoring is decided by whether there is room, not by whether the user is
    # currently over: a suppressed node reports nothing, so "no longer over"
    # would be true the instant they were cut, and they would be restored,
    # reconnect, and be cut again on the next tick, forever.
    room = limit - len(standing)
    for node_id in sorted(held):
        if room <= 0:
            break
        if await _restore(node_id, user):
            held.discard(node_id)
            room -= 1
            logger.info("user %s has room again; restored on node %s", user.id, node_id)

    # Suppression is re-asserted rather than trusted to stick. Any ordinary sync
    # -- the operator edits the user, a group changes, the node reconnects and
    # asks for its user set -- carries the user's full entitlement and would put
    # the peer back on a node they are being held off, silently and for good,
    # since a held node is not asked about and so would never be seen again.
    for node_id in held:
        await _suppress(node_id, user)

    if held:
        _suppressed[user.id] = held
    else:
        _suppressed.pop(user.id, None)


async def enforce_ip_limits() -> None:
    now = time.monotonic()
    async with GetDB() as db:
        node_ids = list((await db.execute(select(Node.id))).scalars().all())
        if not node_ids:
            return

        stmt = select(User).where(
            User.status.in_([UserStatus.active, UserStatus.on_hold]),
            User.ip_limit.is_not(None),
            User.ip_limit > 0,
        )
        limited = list((await db.execute(stmt)).scalars().all())
        limited_ids = {user.id for user in limited}

        # Someone who has since lost their limit, or been disabled, is released
        # rather than left held off a node with nothing to lift the suppression.
        for user_id in list(_suppressed):
            if user_id in limited_ids:
                continue
            stale = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
            if stale is None:
                _suppressed.pop(user_id, None)
                _first_seen.pop(user_id, None)
                continue
            for node_id in list(_suppressed.get(user_id, set())):
                if await _restore(node_id, stale):
                    _suppressed[user_id].discard(node_id)
            if not _suppressed.get(user_id):
                _suppressed.pop(user_id, None)
                _first_seen.pop(user_id, None)

        for user in limited:
            try:
                await _enforce_for_user(user, node_ids, now)
            except Exception as exc:
                logger.error("ip limit check failed for user %s: %s", user.id, exc)


@on_startup
async def start_ip_limit_job():
    if not runtime_settings.role.runs_node:
        return

    scheduler.add_job(
        enforce_ip_limits,
        "interval",
        seconds=job_settings.enforce_ip_limits_interval,
        coalesce=True,
        max_instances=1,
        id="enforce_ip_limits",
        replace_existing=True,
    )
