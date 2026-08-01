"""WireGuard device limit counted across nodes.

A node can never see more than one WireGuard device per user — one key holds one
endpoint per interface — so a user gets a free extra device for every location
they are given. Only the panel sees all nodes, so the count happens there, and
it counts *nodes*, not addresses: behind a relay every node reports the same
source IP and a distinct-address count would collapse to one.
"""

from types import SimpleNamespace

from app.jobs.wireguard_device_limit import _wireguard_node_ids


def _lists(nodes: dict):
    return SimpleNamespace(
        nodes={
            nid: (None if v is None else SimpleNamespace(ips=v[0], ip_protocol=v[1]))
            for nid, v in nodes.items()
        }
    )


def test_no_nodes_means_nobody_connected():
    assert _wireguard_node_ids(_lists({})) == {}


def test_a_node_that_did_not_answer_is_skipped():
    assert _wireguard_node_ids(_lists({1: None})) == {}


def test_one_device_on_one_node():
    got = _wireguard_node_ids(_lists({1: ({"5.5.5.5": 1700}, {"5.5.5.5": "wg"})}))
    assert got == {1: 1700}


def test_same_relay_address_on_two_nodes_counts_as_two_devices():
    # The whole point: clients behind a relay share one address, so counting
    # distinct IPs would say "1 device" while the user runs two.
    got = _wireguard_node_ids(
        _lists(
            {
                1: ({"20.20.20.1": 1700}, {"20.20.20.1": "wg"}),
                2: ({"20.20.20.1": 1750}, {"20.20.20.1": "wg"}),
            }
        )
    )
    assert got == {1: 1700, 2: 1750}


def test_other_protocols_do_not_count():
    # IKEv2 and OpenVPN enforce their own limits on the node; counting them
    # here would disconnect WireGuard for someone who is within their limit.
    got = _wireguard_node_ids(
        _lists(
            {
                1: ({"5.5.5.5": 1700}, {"5.5.5.5": "ikev2"}),
                2: ({"6.6.6.6": 1710}, {"6.6.6.6": "openvpn"}),
                3: ({"7.7.7.7": 1720}, {"7.7.7.7": "xray"}),
            }
        )
    )
    assert got == {}


def test_mixed_protocols_on_one_node_report_only_the_wireguard_activity():
    got = _wireguard_node_ids(
        _lists({1: ({"5.5.5.5": 1700, "6.6.6.6": 1999}, {"5.5.5.5": "wg", "6.6.6.6": "xray"})})
    )
    assert got == {1: 1700}


def test_newest_activity_wins_within_a_node():
    got = _wireguard_node_ids(
        _lists({1: ({"5.5.5.5": 1700, "6.6.6.6": 1800}, {"5.5.5.5": "wg", "6.6.6.6": "wg"})})
    )
    assert got == {1: 1800}


def test_node_with_no_protocol_map_is_ignored():
    # An older node that does not report protocols must not be guessed at.
    assert _wireguard_node_ids(_lists({1: ({"5.5.5.5": 1700}, {})})) == {}


def test_the_oldest_sessions_are_the_ones_kept():
    active = _wireguard_node_ids(
        _lists(
            {
                1: ({"20.20.20.1": 1000}, {"20.20.20.1": "wg"}),
                2: ({"20.20.20.1": 3000}, {"20.20.20.1": "wg"}),
                3: ({"20.20.20.1": 2000}, {"20.20.20.1": "wg"}),
            }
        )
    )
    ordered = sorted(active.items(), key=lambda kv: kv[1])
    limit = 1
    dropped = [nid for nid, _ in ordered[limit:]]
    # Node 1 has been connected longest, so it keeps working; the two newer
    # devices are the ones disconnected.
    assert dropped == [3, 2]
