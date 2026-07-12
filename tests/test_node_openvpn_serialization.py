from app.models.protocol import ProxyProtocol
from app.node.user import _serialize_user_for_node


def _settings():
    return {
        "openvpn": {"serial": "12345", "fingerprint": "ab" * 32},
        "vmess": {"id": "00000000-0000-0000-0000-000000000000"},
    }


def test_openvpn_fields_present_when_allowed():
    proto = _serialize_user_for_node(
        7, _settings(), inbounds=["ovpn"], allowed_protocols=frozenset((ProxyProtocol.openvpn,))
    )
    assert proto.email == "7"
    assert proto.proxies.openvpn.serial == "12345"
    assert proto.proxies.openvpn.fingerprint == "ab" * 32


def test_openvpn_fields_absent_when_not_allowed():
    proto = _serialize_user_for_node(
        7, _settings(), inbounds=["vmess-in"], allowed_protocols=frozenset((ProxyProtocol.vmess,))
    )
    # serial not populated for a non-openvpn core
    assert proto.proxies.openvpn.serial == ""
