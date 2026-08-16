from enum import IntEnum


class ProxyProtocol(IntEnum):
    vmess = 1
    vless = 2
    trojan = 3
    shadowsocks = 4
    wireguard = 5
    hysteria = 6
    openvpn = 7
    # back from the ikev2 era for L2TP/IPsec: its PPP layer authenticates with
    # the same username/password credential, so the protocol outlives the core
    ikev2 = 8

    @classmethod
    def from_value(cls, value: str) -> ProxyProtocol | None:
        try:
            return _PROXY_PROTOCOL_BY_NAME[value]
        except KeyError:
            return None


_PROXY_PROTOCOL_BY_NAME = {protocol.name: protocol for protocol in ProxyProtocol}
