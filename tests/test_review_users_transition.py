"""The limit/expire jobs must not strand users mid-batch.

Both jobs select only users who are still *active*. So the moment a user's flip
to limited/expired is committed, this job can never see them again — if the
dispatch that takes them off the nodes does not happen, their sessions stay up
and nothing revisits them. Flipping the whole batch in one commit and then
dispatching in a loop meant a single failure did exactly that to every user
after it.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.db.models import UserStatus
from app.jobs import review_users


def _users(n: int):
    return [SimpleNamespace(id=i, username=f"u{i}") for i in range(1, n + 1)]


@pytest.mark.asyncio
async def test_one_failure_does_not_strand_the_rest(monkeypatch: pytest.MonkeyPatch):
    users = _users(4)
    flipped: list[int] = []
    dispatched: list[int] = []

    async def fake_update_users_status(db, batch, status):
        flipped.extend(u.id for u in batch)
        return batch

    async def fake_change_status(db, user, status):
        if user.id == 2:
            raise RuntimeError("next plan reset blew up")
        dispatched.append(user.id)

    monkeypatch.setattr(review_users, "update_users_status", fake_update_users_status)
    monkeypatch.setattr(review_users, "change_status", fake_change_status)
    db = SimpleNamespace(rollback=AsyncMock())

    await review_users._transition_users(db, users, UserStatus.limited)

    assert dispatched == [1, 3, 4], "a failing user aborted the batch; everyone after it stayed live on the nodes"
    assert db.rollback.await_count == 1


@pytest.mark.asyncio
async def test_each_user_is_committed_on_their_own(monkeypatch: pytest.MonkeyPatch):
    # What makes the job resumable: users not yet reached are still active, so
    # the next tick selects them again. A single batch-wide commit would take
    # them out of the query for good.
    users = _users(3)
    batches: list[list[int]] = []

    async def fake_update_users_status(db, batch, status):
        batches.append([u.id for u in batch])
        return batch

    monkeypatch.setattr(review_users, "update_users_status", fake_update_users_status)
    monkeypatch.setattr(review_users, "change_status", AsyncMock())

    await review_users._transition_users(SimpleNamespace(rollback=AsyncMock()), users, UserStatus.expired)

    assert batches == [[1], [2], [3]], f"status was not committed per user: {batches}"


@pytest.mark.asyncio
async def test_status_is_committed_before_the_user_is_dispatched(monkeypatch: pytest.MonkeyPatch):
    # serialize_user decides to send inbounds=None from the user's status, so
    # the flip has to land before the dispatch reads it.
    order: list[str] = []

    async def fake_update_users_status(db, batch, status):
        order.append("flip")
        return batch

    async def fake_change_status(db, user, status):
        order.append("dispatch")

    monkeypatch.setattr(review_users, "update_users_status", fake_update_users_status)
    monkeypatch.setattr(review_users, "change_status", fake_change_status)

    await review_users._transition_users(SimpleNamespace(rollback=AsyncMock()), _users(1), UserStatus.limited)

    assert order == ["flip", "dispatch"]
