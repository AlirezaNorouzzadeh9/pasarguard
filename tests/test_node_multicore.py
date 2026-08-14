"""A node may run more than one core — several WireGuard interfaces, or OpenVPN.

These cover the panel side of that: which cores a node is asked to start, and
what happens to the node when one of the extra ones refuses to come up.
"""

from types import SimpleNamespace

import pytest
from PasarGuardNodeBridge import NodeAPIError

from app.models.core import CoreType
from app.operation.node import NodeOperation


def _node(core_id=1, extra=None):
    return SimpleNamespace(id=7, name="de-1", core_config_id=core_id, additional_core_config_ids=extra)


def _core(core_type=CoreType.wg):
    """Mirrors what the core manager hands back: a parsed config, with no id.

    The id lives beside it in the triple, which is exactly the distinction that
    broke the first deploy.
    """
    return SimpleNamespace(type=core_type, to_str=lambda: "{}")


class _FakeNode:
    """Stands in for the node bridge, recording what it was asked to start."""

    def __init__(self, fail_on=()):
        self.started = []
        self.timeouts = []
        self._calls = 0
        self._fail_on = set(fail_on)

    # timeout is accepted because the operation passes one: bringing up a core
    # with a large peer list outlasts the node's default by minutes, and a
    # double that refuses the argument hides that the call is even made.
    async def add_backend(self, config, backend_type, users, timeout=None):
        call, self._calls = self._calls, self._calls + 1
        if call in self._fail_on:
            raise NodeAPIError(500, "port already in use")
        self.started.append((config, backend_type, users))
        self.timeouts.append(timeout)


def test_primary_core_comes_first():
    """Order matters: the primary is started with the handshake, the rest ride on it."""
    assert NodeOperation._node_core_ids(_node(core_id=3, extra=[5, 9])) == [3, 5, 9]


def test_missing_core_config_falls_back_to_the_default_core():
    assert NodeOperation._node_core_ids(_node(core_id=None)) == [1]


def test_a_core_listed_twice_is_only_started_once():
    assert NodeOperation._node_core_ids(_node(core_id=3, extra=[5, 3, 5])) == [3, 5]


def test_no_additional_cores_behaves_exactly_as_before():
    assert NodeOperation._node_core_ids(_node(core_id=2, extra=None)) == [2]


@pytest.mark.asyncio
async def test_every_extra_wireguard_core_is_started():
    pg_node = _FakeNode()

    problems = await NodeOperation._add_extra_cores(
        pg_node, _node(), [(2, _core(), ["u1"]), (3, _core(), ["u2"])]
    )

    assert problems == ""
    assert [users for _, _, users in pg_node.started] == [["u1"], ["u2"]]


@pytest.mark.asyncio
async def test_an_xray_extra_core_is_refused_not_silently_dropped():
    """A second xray would replace the first on the node, so it must be reported."""
    pg_node = _FakeNode()

    problems = await NodeOperation._add_extra_cores(pg_node, _node(), [(2, _core(CoreType.xray), [])])

    assert pg_node.started == []
    assert "xray" in problems


@pytest.mark.asyncio
async def test_openvpn_runs_alongside_wireguard_with_its_own_backend_type():
    """Both are their own processes, so a node can serve them at once."""
    from PasarGuardNodeBridge.common import service_pb2 as service

    pg_node = _FakeNode()

    problems = await NodeOperation._add_extra_cores(
        pg_node, _node(), [(2, _core(CoreType.wg), ["u1"]), (3, _core(CoreType.openvpn), ["u2"])]
    )

    assert problems == ""
    assert [backend_type for _, backend_type, _ in pg_node.started] == [
        service.BackendType.WIREGUARD,
        service.BackendType.OPENVPN,
    ]


@pytest.mark.asyncio
async def test_a_failing_extra_core_does_not_stop_the_others():
    """The primary is already serving users; one bad core must not take it down."""
    pg_node = _FakeNode(fail_on={0})

    problems = await NodeOperation._add_extra_cores(
        pg_node, _node(), [(2, _core(), ["u1"]), (3, _core(), ["u2"])]
    )

    assert "port already in use" in problems
    assert [users for _, _, users in pg_node.started] == [["u2"]]


@pytest.mark.asyncio
async def test_a_core_that_cannot_be_resolved_is_reported_not_ignored():
    """A core the manager does not know about must not vanish silently."""
    pg_node = _FakeNode()

    problems = await NodeOperation._add_extra_cores(pg_node, _node(), [(9, None, [])])

    assert pg_node.started == []
    assert "core 9 not found" in problems


@pytest.mark.asyncio
async def test_an_unexpected_error_is_contained():
    """The primary core is already serving; an extra one must not take it down."""

    class Exploding:
        async def add_backend(self, **_):
            raise AttributeError("'WireGuardConfig' object has no attribute 'id'")

    problems = await NodeOperation._add_extra_cores(Exploding(), _node(), [(3, _core(), [])])

    assert "no attribute 'id'" in problems
