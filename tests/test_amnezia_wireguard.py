"""AmneziaWG: obfuscation parameters on a WireGuard core.

Plain WireGuard has a fixed handshake size and fixed header bytes, so DPI blocks
it with one rule. These settings pad and randomise those, and every value has to
reach the client verbatim — a peer whose numbers differ from the server's never
completes a handshake, silently. So the validation is strict here rather than
discovered later as "the tunnel connects but nothing happens".
"""

import pytest

from app.core.wireguard import validate_amnezia
from app.models.subscription import SubscriptionInboundData
from app.subscription.wireguard import WireGuardConfiguration

VALID = {"jc": 4, "jmin": 40, "jmax": 70, "s1": 30, "s2": 40, "h1": 10, "h2": 11, "h3": 12, "h4": 13}


@pytest.mark.parametrize("raw", [None, "", {}, {"jc": 0}, {"jc": "", "s1": None}])
def test_absent_block_means_plain_wireguard(raw):
    assert validate_amnezia(raw) == {}


def test_valid_profile_is_normalised_to_ints():
    result = validate_amnezia({k: str(v) for k, v in VALID.items()})
    assert result == VALID


@pytest.mark.parametrize(
    "override,message",
    [
        ({"jmax": 0}, "jmax is required"),
        ({"jmin": 100}, "must not exceed"),
        ({"jmax": 2000}, "must not exceed 1280"),
        ({"jc": 500}, "between 0 and 128"),
        ({"h1": 3}, "must be 5 or greater"),
        ({"h2": 10}, "must all differ"),
        ({"h4": 0}, "must all be set together"),
        ({"s1": 30, "s2": 86}, "must not equal"),
        ({"s1": 5000}, "too large"),
    ],
)
def test_broken_profiles_are_rejected(override, message):
    with pytest.raises(ValueError, match=message):
        validate_amnezia({**VALID, **override})


@pytest.mark.parametrize("bad", [{"jc": "abc"}, {"jc": True}, {"jc": [1]}, "nope", 5])
def test_non_integer_values_are_rejected(bad):
    with pytest.raises(ValueError):
        validate_amnezia(bad)


def test_negative_values_are_rejected():
    with pytest.raises(ValueError, match="must not be negative"):
        validate_amnezia({**VALID, "s1": -1})


def _inbound(**kwargs) -> SubscriptionInboundData:
    from app.models.subscription import TCPTransportConfig, TLSConfig

    return SubscriptionInboundData(
        tag="wg",
        inbound_tag="wg",
        remark="wg",
        protocol="wireguard",
        port=[51820],
        address=["example.com"],
        network="udp",
        tls_config=TLSConfig(),
        transport_config=TCPTransportConfig(path="", host=[]),
        wireguard_public_key="pub",
        **kwargs,
    )


def test_conf_carries_the_parameters_in_client_casing():
    lines = WireGuardConfiguration._amnezia_lines(_inbound(wireguard_amnezia=VALID))
    assert lines == {
        "Jc": "4",
        "Jmin": "40",
        "Jmax": "70",
        "S1": "30",
        "S2": "40",
        "H1": "10",
        "H2": "11",
        "H3": "12",
        "H4": "13",
    }


def test_plain_wireguard_conf_is_unchanged():
    # An ordinary core must not grow Amnezia lines, or every existing client
    # config would change for no reason.
    assert WireGuardConfiguration._amnezia_lines(_inbound()) == {}
    assert WireGuardConfiguration._amnezia_lines(_inbound(wireguard_amnezia={})) == {}


def test_zero_values_are_omitted_not_written_as_zero():
    lines = WireGuardConfiguration._amnezia_lines(_inbound(wireguard_amnezia={"jc": 4, "s1": 0}))
    assert lines == {"Jc": "4"}
