import datetime

from cryptography import x509
from cryptography.x509.oid import ExtendedKeyUsageOID

from app.utils import openvpn_pki as pki


def test_generate_ca_is_a_ca():
    ca_cert, ca_key = pki.generate_ca()
    cert = x509.load_pem_x509_certificate(ca_cert.encode())
    bc = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert bc.ca is True
    assert "BEGIN PRIVATE KEY" in ca_key


def test_issue_client_cert_fields():
    ca_cert, ca_key = pki.generate_ca()
    cc = pki.issue_client_cert(ca_cert, ca_key, "42", days=3650)

    # serial is a decimal string that matches OpenVPN's tls_serial_0
    assert cc.serial.isdigit()
    cert = x509.load_pem_x509_certificate(cc.cert_pem.encode())
    assert str(cert.serial_number) == cc.serial

    # CN equals the user id
    cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
    assert cn == "42"

    # fingerprint is sha256 hex of the DER cert
    assert len(cc.fingerprint) == 64
    assert cert.fingerprint(__import__("cryptography").hazmat.primitives.hashes.SHA256()).hex() == cc.fingerprint

    # client auth EKU
    eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.CLIENT_AUTH in eku


def test_issue_server_cert_has_server_eku():
    ca_cert, ca_key = pki.generate_ca()
    server_cert, server_key = pki.issue_server_cert(ca_cert, ca_key, "ovpn-main")
    cert = x509.load_pem_x509_certificate(server_cert.encode())
    eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in eku
    assert "BEGIN PRIVATE KEY" in server_key


def test_two_client_certs_have_distinct_serials():
    ca_cert, ca_key = pki.generate_ca()
    a = pki.issue_client_cert(ca_cert, ca_key, "1")
    b = pki.issue_client_cert(ca_cert, ca_key, "1")
    assert a.serial != b.serial


def test_tls_crypt_key_format():
    key = pki.generate_tls_crypt_key()
    assert "BEGIN OpenVPN Static key V1" in key
    assert "END OpenVPN Static key V1" in key


def test_cert_needs_renewal():
    assert pki.cert_needs_renewal(None) is True
    assert pki.cert_needs_renewal("not a cert") is True

    ca_cert, ca_key = pki.generate_ca()
    cc = pki.issue_client_cert(ca_cert, ca_key, "1", days=3650)
    assert pki.cert_needs_renewal(cc.cert_pem) is False

    short = pki.issue_client_cert(ca_cert, ca_key, "1", days=10)
    assert pki.cert_needs_renewal(short.cert_pem, margin_days=30) is True

    # not_after is a tz-aware datetime in the future (serialized to ISO in proxy_settings)
    assert cc.not_after > datetime.datetime.now(datetime.timezone.utc)
