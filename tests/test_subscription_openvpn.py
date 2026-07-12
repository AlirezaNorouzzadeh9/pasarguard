import io
import zipfile

from app.models.subscription import SubscriptionInboundData, TCPTransportConfig, TLSConfig
from app.subscription.openvpn import OpenVPNConfiguration
from app.utils import openvpn_pki as pki


def _inbound(**overrides) -> SubscriptionInboundData:
    ca_cert, ca_key = pki.generate_ca()
    tc = pki.generate_tls_crypt_key()
    base = dict(
        remark="DE",
        inbound_tag="ovpn",
        protocol="openvpn",
        address="1.2.3.4",
        port=1194,
        network="udp",
        tls_config=TLSConfig(),
        transport_config=TCPTransportConfig(path="", host=[]),
        openvpn_ca_cert=ca_cert,
        openvpn_tls_crypt_key=tc,
        openvpn_data_ciphers=["AES-256-GCM", "CHACHA20-POLY1305"],
        openvpn_dns=["1.1.1.1"],
    )
    base.update(overrides)
    inbound = SubscriptionInboundData(**base)
    return inbound, ca_cert, ca_key


def _names_and_body(conf: OpenVPNConfiguration):
    z = zipfile.ZipFile(io.BytesIO(conf.render()))
    names = z.namelist()
    body = z.read(names[0]).decode() if names else ""
    return names, body


def test_render_contains_all_blocks():
    inbound, ca_cert, ca_key = _inbound()
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")

    conf = OpenVPNConfiguration()
    conf.add("DE", "1.2.3.4", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    names, body = _names_and_body(conf)

    assert names == ["DE.ovpn"]
    for token in (
        "client",
        "remote 1.2.3.4 1194",
        "proto udp",
        "remote-cert-tls server",
        "data-ciphers AES-256-GCM:CHACHA20-POLY1305",
        "dhcp-option DNS 1.1.1.1",
        "redirect-gateway def1 bypass-dhcp",
        "<ca>",
        "<cert>",
        "<key>",
        "<tls-crypt>",
    ):
        assert token in body, token


def test_user_without_cert_is_skipped():
    inbound, _, _ = _inbound()
    conf = OpenVPNConfiguration()
    conf.add("DE", "1.2.3.4", inbound, {})
    names, _ = _names_and_body(conf)
    assert names == []


def test_host_override_proto_and_mtu():
    inbound, ca_cert, ca_key = _inbound(openvpn_proto="tcp", openvpn_mtu=1400, openvpn_redirect_gateway=False)
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "1.2.3.4", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    assert "proto tcp" in body
    assert "tun-mtu 1400" in body
    assert "redirect-gateway" not in body
