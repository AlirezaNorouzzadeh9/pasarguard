"""The panel-side half of the connection limit: which node gives way.

Only the selection is exercised here. Talking to nodes is mocked out in the job
itself, so these cover the part that decides policy: the newest address is the
one that goes, and a node holding an older connection is never disturbed.
"""

import pytest

from app.jobs import ip_limit


@pytest.fixture(autouse=True)
def clean_state():
    ip_limit._first_seen.clear()
    ip_limit._suppressed.clear()
    yield
    ip_limit._first_seen.clear()
    ip_limit._suppressed.clear()


def test_within_the_limit_nothing_is_suppressed():
    seen = {(1, "1.1.1.1")}
    ip_limit._track_addresses(7, seen, now=100.0)

    assert ip_limit._nodes_to_suppress(7, seen, limit=1) == set()


def test_the_newest_node_is_the_one_held_off():
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    seen = {(1, "1.1.1.1"), (2, "2.2.2.2")}
    ip_limit._track_addresses(7, seen, now=200.0)

    assert ip_limit._nodes_to_suppress(7, seen, limit=1) == {2}


def test_a_node_with_an_older_connection_is_left_alone():
    # One node carries both an old and a new address. Cutting it would end the
    # old session too, so it is spared even though it is over the limit.
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    seen = {(1, "1.1.1.1"), (1, "3.3.3.3")}
    ip_limit._track_addresses(7, seen, now=200.0)

    assert ip_limit._nodes_to_suppress(7, seen, limit=1) == set()


def test_only_the_nodes_past_the_limit_are_held_off():
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    ip_limit._track_addresses(7, {(1, "1.1.1.1"), (2, "2.2.2.2")}, now=200.0)
    seen = {(1, "1.1.1.1"), (2, "2.2.2.2"), (3, "3.3.3.3")}
    ip_limit._track_addresses(7, seen, now=300.0)

    assert ip_limit._nodes_to_suppress(7, seen, limit=2) == {3}


def test_first_sight_survives_later_ticks():
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=500.0)

    assert ip_limit._first_seen[7][(1, "1.1.1.1")] == 100.0


def test_an_address_that_goes_away_is_forgotten():
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    ip_limit._track_addresses(7, set(), now=200.0)

    assert ip_limit._first_seen[7] == {}


def test_a_returning_address_is_dated_as_new():
    # Someone who disconnects and comes back is the newcomer, not the incumbent.
    ip_limit._track_addresses(7, {(1, "1.1.1.1")}, now=100.0)
    ip_limit._track_addresses(7, set(), now=200.0)
    ip_limit._track_addresses(7, {(2, "2.2.2.2")}, now=300.0)
    seen = {(1, "1.1.1.1"), (2, "2.2.2.2")}
    ip_limit._track_addresses(7, seen, now=400.0)

    assert ip_limit._nodes_to_suppress(7, seen, limit=1) == {1}


def test_only_recently_seen_addresses_count():
    # The nodes report last-seen and never expire an entry: a WireGuard endpoint
    # is remembered for the life of the interface, and xray holds one for minutes
    # after the client is gone. Counting those would let an address nobody is
    # using occupy a slot.
    now = 1_000_000.0
    ips = {
        "1.1.1.1": int(now - 5),
        "2.2.2.2": int(now - ip_limit.ONLINE_WINDOW_SECONDS - 60),
    }

    assert ip_limit._fresh(ips, now) == {"1.1.1.1": int(now - 5)}


def test_an_address_seen_right_at_the_edge_still_counts():
    now = 1_000_000.0
    ips = {"1.1.1.1": int(now - ip_limit.ONLINE_WINDOW_SECONDS)}

    assert ip_limit._fresh(ips, now) == ips
