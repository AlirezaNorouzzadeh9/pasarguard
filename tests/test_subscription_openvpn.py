import io
import zipfile

import pytest

from app.models.host import OpenVPNHostOverrides, OpenVPNRemote
from app.models.subscription import SubscriptionInboundData, TCPTransportConfig, TLSConfig
from app.subscription.openvpn import OpenVPNConfiguration
from app.subscription.share import process_host
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


def test_single_remote_keeps_classic_form():
    inbound, ca_cert, ca_key = _inbound(openvpn_remotes=["1.2.3.4"])
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "1.2.3.4", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    # One remote -> global proto line + bare `remote host port`.
    assert "proto udp" in body
    assert "remote 1.2.3.4 1194" in body


def test_multi_remote_failover():
    inbound, ca_cert, ca_key = _inbound(
        openvpn_proto="tcp",
        openvpn_remotes=["de1.example.com", "de2.example.com", "5.6.7.8"],
    )
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "de1.example.com", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    # Several remotes -> per-remote proto lines, no global `proto` directive.
    assert "remote de1.example.com 1194 tcp" in body
    assert "remote de2.example.com 1194 tcp" in body
    assert "remote 5.6.7.8 1194 tcp" in body
    assert "\nproto tcp\n" not in body
    # Domains work as remotes (option 2).
    assert body.count("remote ") == 3


def test_address_entries_carry_proto_and_port():
    # A single Address field where each entry is "host [port] [proto]" drives
    # failover and per-remote proto/port; missing parts inherit host defaults.
    inbound, ca_cert, ca_key = _inbound(
        openvpn_proto="udp",
        openvpn_remotes=[
            "172.234.115.82 1194 udp",
            "172.234.115.84 443 tcp",
            "de.example.com",  # no port/proto -> inherit host defaults (1194/udp)
        ],
    )
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "172.234.115.82", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    assert "remote 172.234.115.82 1194 udp" in body
    assert "remote 172.234.115.84 443 tcp" in body
    assert "remote de.example.com 1194 udp" in body  # inherited port 1194 + proto udp
    assert "\nproto udp\n" not in body  # per-remote form, no global proto
    assert body.count("remote ") == 3


def test_single_address_with_explicit_proto_uses_per_remote_form():
    # One entry but with an explicit proto -> per-remote form (no global proto).
    inbound, ca_cert, ca_key = _inbound(openvpn_remotes=["1.2.3.4 8080 tcp"])
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "1.2.3.4", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    assert "remote 1.2.3.4 8080 tcp" in body
    assert "\nproto " not in body


def test_structured_remotes_inherit_defaults():
    # Structured remotes: per-remote proto/port with fallback to host defaults.
    inbound, ca_cert, ca_key = _inbound(
        openvpn_proto="udp",
        openvpn_remotes=[
            OpenVPNRemote(host="172.234.115.82", port=1194, proto="udp"),
            OpenVPNRemote(host="172.234.115.84", port=443, proto="tcp"),
            OpenVPNRemote(host="de.example.com"),  # inherit host defaults (1194/udp)
        ],
    )
    cc = pki.issue_client_cert(ca_cert, ca_key, "7")
    conf = OpenVPNConfiguration()
    conf.add("DE", "172.234.115.82", inbound, {"cert_pem": cc.cert_pem, "private_key_pem": cc.key_pem})
    _, body = _names_and_body(conf)
    assert "remote 172.234.115.82 1194 udp" in body
    assert "remote 172.234.115.84 443 tcp" in body
    assert "remote de.example.com 1194 udp" in body
    assert "\nproto udp\n" not in body  # per-remote form, no global proto
    assert body.count("remote ") == 3


def test_legacy_proto_without_port_is_parsed():
    # "host proto" (no port) previously dropped the proto silently.
    remote = OpenVPNRemote.parse("1.2.3.4 tcp")
    assert remote.host == "1.2.3.4"
    assert remote.port is None
    assert remote.proto == "tcp"


def test_overrides_remotes_coerce_legacy_strings():
    over = OpenVPNHostOverrides(remotes=["1.2.3.4 443 tcp", {"host": "de.example.com", "port": 8080}])
    assert over.remotes[0] == OpenVPNRemote(host="1.2.3.4", port=443, proto="tcp")
    assert over.remotes[1] == OpenVPNRemote(host="de.example.com", port=8080)


@pytest.mark.asyncio
async def test_process_host_populates_all_remotes():
    # A host carrying multiple addresses should surface every one as a remote
    # (failover), not collapse to a single random pick like other protocols.
    inbound, _, _ = _inbound(address=["de1.example.com", "de2.example.com", "5.6.7.8"], port=[1194])
    result = await process_host(
        inbound,
        format_variables={},
        inbounds=["ovpn"],
        proxies={"openvpn": {"cert_pem": "x"}, "_user_id": 7},
    )
    assert result is not None
    inbound_copy, _ = result
    hosts = {remote.host for remote in inbound_copy.openvpn_remotes}
    assert hosts == {"de1.example.com", "de2.example.com", "5.6.7.8"}
    # The single `address` is still one of them (used by the <=1 fallback path).
    assert inbound_copy.address in hosts


@pytest.mark.asyncio
async def test_process_host_prefers_structured_remotes():
    # Structured remotes from host overrides win over the plain address list.
    inbound, _, _ = _inbound(
        address=["ignored.example.com"],
        port=[1194],
        openvpn_remotes=[OpenVPNRemote(host="win.example.com", port=443, proto="tcp")],
    )
    result = await process_host(
        inbound,
        format_variables={},
        inbounds=["ovpn"],
        proxies={"openvpn": {"cert_pem": "x"}, "_user_id": 7},
    )
    assert result is not None
    inbound_copy, _ = result
    assert inbound_copy.openvpn_remotes == [OpenVPNRemote(host="win.example.com", port=443, proto="tcp")]
