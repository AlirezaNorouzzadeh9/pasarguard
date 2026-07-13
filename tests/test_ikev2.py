import io
import zipfile

import pytest

from app.core.ikev2 import IKEv2Config
from app.models.subscription import SubscriptionInboundData, TCPTransportConfig, TLSConfig
from app.subscription.ikev2 import IKEv2Configuration
from app.utils import openvpn_pki as pki


def _material():
    ca_cert, ca_key = pki.generate_ca()
    server_cert, server_key = pki.issue_ikev2_server_cert(ca_cert, ca_key, "172.234.115.84")
    return ca_cert, ca_key, server_cert, server_key


def test_ikev2_config_validates_and_hides_key():
    ca_cert, _, server_cert, server_key = _material()
    cfg = IKEv2Config(
        {
            "inbound_tag": "ikev2-main",
            "server_addr": "172.234.115.84",
            "pool": "10.30.0.0/24",
            "ca_cert": ca_cert,
            "server_cert": server_cert,
            "server_key": server_key,
        }
    )
    assert cfg.inbounds == ["ikev2-main"]
    meta = cfg.inbounds_by_tag["ikev2-main"]
    assert meta["protocol"] == "ikev2"
    assert meta["identity"] == "172.234.115.84"
    # server_key / ca_key must never leak into inbound metadata.
    assert "server_key" not in meta and "ca_key" not in meta


def test_ikev2_config_requires_material():
    with pytest.raises(ValueError):
        IKEv2Config({"inbound_tag": "ikev2-main", "server_addr": "1.2.3.4", "pool": "10.30.0.0/24"})


def test_ikev2_server_cert_has_san_and_ike_eku():
    from cryptography import x509

    ca_cert, ca_key, server_cert, _ = _material()
    cert = x509.load_pem_x509_certificate(server_cert.encode())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "172.234.115.84" in [str(g.value) for g in san]
    ekus = [e.dotted_string for e in cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value]
    assert "1.3.6.1.5.5.7.3.1" in ekus  # serverAuth
    assert "1.3.6.1.5.5.7.3.17" in ekus  # ipsecIKE


def _inbound(ca_cert):
    return SubscriptionInboundData(
        remark="DE",
        inbound_tag="ikev2-main",
        protocol="ikev2",
        address="172.234.115.84",
        port=500,
        network="udp",
        tls_config=TLSConfig(),
        transport_config=TCPTransportConfig(path="", host=[]),
        ikev2_server_addr="172.234.115.84",
        ikev2_identity="172.234.115.84",
        ikev2_ca_cert=ca_cert,
    )


def test_mobileconfig_render():
    ca_cert, *_ = _material()
    conf = IKEv2Configuration()
    conf.add("DE", "172.234.115.84", _inbound(ca_cert), {"username": "7", "password": "SecretPass123"})
    z = zipfile.ZipFile(io.BytesIO(conf.render()))
    assert any(n.endswith(".mobileconfig") for n in z.namelist())
    mc = z.read([n for n in z.namelist() if n.endswith(".mobileconfig")][0]).decode()
    for token in ("VPNType", "IKEv2", "RemoteAddress", "172.234.115.84", "AuthName", "SecretPass123", "com.apple.security.root"):
        assert token in mc, token


def test_user_without_creds_is_skipped():
    ca_cert, *_ = _material()
    conf = IKEv2Configuration()
    conf.add("DE", "172.234.115.84", _inbound(ca_cert), {})
    assert zipfile.ZipFile(io.BytesIO(conf.render())).namelist() == []
