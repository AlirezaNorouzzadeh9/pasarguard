"""Traffic is zeroed on the node before it is written down; a failed write must
not destroy it -- and a retried write must never bill the same bytes twice.

get_stats(reset=True) takes the counters off the node, so between that call and
the database write the only copy lives in this process. The carry buffers turn
that loss into delay -- but only for failures that are *certain* to have rolled
back (deadlock, lock wait timeout). A connection lost around COMMIT or a
cancellation may have committed before it raised; re-applying that window would
charge the user for bytes they never used, so it is dropped instead.
"""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import OperationalError

from app.jobs import record_usages


def _deadlock() -> OperationalError:
    """A MySQL deadlock: the transaction is certain to have rolled back."""
    return OperationalError("stmt", {}, Exception(1213, "Deadlock found when trying to get lock"))


def _connection_lost() -> OperationalError:
    """A connection dropped around COMMIT: the write may or may not have landed."""
    return OperationalError("stmt", {}, Exception(2013, "Lost connection to MySQL server during query"))


@pytest.fixture(autouse=True)
def _clear_carry():
    record_usages._carried_user_usage = {}
    record_usages._carried_admin_usage = {}
    record_usages._carried_node_params = {}
    record_usages._carried_node_coefficients = {}
    yield
    record_usages._carried_user_usage = {}
    record_usages._carried_admin_usage = {}
    record_usages._carried_node_params = {}
    record_usages._carried_node_coefficients = {}


def test_merge_folds_carried_amounts_into_this_cycle():
    fresh = [{"uid": 1, "value": 100}, {"uid": 2, "value": 50}]
    carried = {1: 700, 3: 20}
    merged = {int(item["uid"]): item["value"] for item in record_usages._merge_usage(fresh, carried)}
    assert merged == {1: 800, 2: 50, 3: 20}


def test_merge_without_carry_is_the_identity():
    fresh = [{"uid": 1, "value": 100}]
    assert record_usages._merge_usage(fresh, {}) is fresh


def test_a_deadlock_is_a_certain_rollback():
    assert record_usages._write_rolled_back(_deadlock())


def test_a_lock_wait_timeout_is_a_certain_rollback():
    exc = OperationalError("stmt", {}, Exception(1205, "Lock wait timeout exceeded"))
    assert record_usages._write_rolled_back(exc)


def test_a_lost_connection_is_not_certain_to_have_rolled_back():
    assert not record_usages._write_rolled_back(_connection_lost())


def test_a_cancellation_is_not_certain_to_have_rolled_back():
    # The job's own 120s timeout cancels mid-write; the COMMIT may have landed.
    import asyncio

    assert not record_usages._write_rolled_back(asyncio.CancelledError())


def test_an_unknown_error_is_not_certain_to_have_rolled_back():
    assert not record_usages._write_rolled_back(RuntimeError("db down"))


@pytest.mark.asyncio
async def test_a_rolled_back_user_write_is_retried_next_cycle(monkeypatch: pytest.MonkeyPatch):
    """A cycle whose write certainly rolled back leaves the traffic parked; the
    next one adds its own and writes the sum."""
    written: list[list[dict]] = []
    fail = {"now": True}

    async def fake_safe_execute(stmt, params=None, max_retries: int = 2):
        if fail["now"]:
            raise _deadlock()
        written.append(list(params or []))

    monkeypatch.setattr(record_usages, "safe_execute", fake_safe_execute)

    async def one_cycle(usage: list[dict]):
        # The shape of the job's write step, with the same parking discipline.
        merged = record_usages._merge_usage(usage, record_usages._carried_user_usage)
        record_usages._carried_user_usage = {}
        try:
            await record_usages.safe_execute(object(), merged)
        except BaseException as exc:
            if record_usages._write_rolled_back(exc):
                record_usages._carried_user_usage = {int(u["uid"]): int(u["value"]) for u in merged}
            raise

    with pytest.raises(OperationalError):
        await one_cycle([{"uid": 7, "value": 500}])
    assert record_usages._carried_user_usage == {7: 500}, "traffic already reset on the node was dropped"
    assert written == []

    fail["now"] = False
    await one_cycle([{"uid": 7, "value": 300}])

    assert record_usages._carried_user_usage == {}
    assert written == [[{"uid": 7, "value": 800}]], "the held-over window was not added to the next write"


@pytest.mark.asyncio
async def test_admin_totals_are_carried_separately_from_users():
    """If only the user write fails, the admin write must not be repeated: admin
    usage is derived from user usage, so re-deriving it from the merged users
    would bill the admin twice for the same bytes."""
    record_usages._carried_user_usage = {7: 500}
    record_usages._carried_admin_usage = {}

    fresh_users = [{"uid": 7, "value": 300}]
    fresh_admin = {1: 300}

    merged_users = record_usages._merge_usage(fresh_users, record_usages._carried_user_usage)
    merged_admin = dict(fresh_admin)
    for admin_id, value in record_usages._carried_admin_usage.items():
        merged_admin[admin_id] = merged_admin.get(admin_id, 0) + value

    assert {int(u["uid"]): u["value"] for u in merged_users} == {7: 800}
    assert merged_admin == {1: 300}, "admin was billed for bytes it had already been billed for"


@pytest.mark.asyncio
async def test_carried_node_batch_keeps_its_own_coefficients(monkeypatch: pytest.MonkeyPatch):
    """A held-over node batch is retried with the coefficients that were in
    force when it was collected, not whatever they are now."""
    calls: list[tuple[dict, dict]] = []

    async def fake_batched(params, coefficients):
        calls.append((params, dict(coefficients)))

    monkeypatch.setattr(record_usages, "record_user_stats_batched", fake_batched)

    record_usages._carried_node_params = {5: [{"uid": 7, "value": 100}]}
    record_usages._carried_node_coefficients = {5: 2.0}

    retry_params = record_usages._carried_node_params
    retry_coefficients = record_usages._carried_node_coefficients
    await record_usages.record_user_stats_batched(retry_params, retry_coefficients)
    record_usages._carried_node_params, record_usages._carried_node_coefficients = {}, {}

    await record_usages.record_user_stats_batched({5: [{"uid": 7, "value": 40}]}, {5: 1.0})

    assert calls[0] == ({5: [{"uid": 7, "value": 100}]}, {5: 2.0})
    assert calls[1] == ({5: [{"uid": 7, "value": 40}]}, {5: 1.0})


def _job_with_write_error(monkeypatch: pytest.MonkeyPatch, error: BaseException):
    class FakeNode:
        async def get_extra(self):
            return {"usage_coefficient": 1}

    node = FakeNode()
    monkeypatch.setattr(record_usages.node_manager, "get_healthy_nodes", AsyncMock(return_value=[(1, node)]))
    monkeypatch.setattr(record_usages, "get_users_stats", AsyncMock(return_value=[{"uid": 7, "value": 500}]))
    monkeypatch.setattr(record_usages, "calculate_admin_usage", AsyncMock(return_value=({}, {7})))
    monkeypatch.setattr(record_usages, "safe_execute", AsyncMock(side_effect=error))
    monkeypatch.setattr(record_usages.usage_settings, "disable_recording_node_usage", True)


@pytest.mark.asyncio
async def test_job_holds_the_window_when_the_write_rolled_back(monkeypatch: pytest.MonkeyPatch):
    """End to end through the real job: a deadlocked write must leave the
    traffic parked rather than gone."""
    _job_with_write_error(monkeypatch, _deadlock())

    # The job lets the failure reach the scheduler, which logs it. What matters
    # is that the window it had already taken off the node is still held.
    with pytest.raises(OperationalError):
        await record_usages.record_user_usages()

    assert record_usages._carried_user_usage == {7: 500}, (
        "the node's counters were reset and the write rolled back, so this window is only in memory — it must be held"
    )


@pytest.mark.asyncio
async def test_job_drops_the_window_when_the_write_may_have_committed(monkeypatch: pytest.MonkeyPatch):
    """End to end through the real job: a write that failed ambiguously may
    already be on disk, so re-applying it would bill the same bytes twice.
    The window is dropped -- loss is the lesser harm."""
    _job_with_write_error(monkeypatch, _connection_lost())

    with pytest.raises(OperationalError):
        await record_usages.record_user_usages()

    assert record_usages._carried_user_usage == {}, (
        "an ambiguous failure was re-parked; if the COMMIT had landed, the user would be billed twice"
    )
