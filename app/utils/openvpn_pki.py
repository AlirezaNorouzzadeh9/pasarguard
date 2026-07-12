"""OpenVPN PKI helpers.

The panel owns a single OpenVPN CA (stored in the Settings singleton). Every
OpenVPN server core gets a server certificate issued from that CA, and every
user gets a client certificate whose Common Name is ``str(user.id)``.

The node authorizes a connecting client by matching its certificate CN against
the synced user list and (optionally) the certificate serial. Because
authorization is a positive allowlist on the node, revocation does not require a
CRL: dropping the user from the sync list (or issuing a new serial) is enough.

Serial numbers are stored and transmitted as **decimal strings** so they match
OpenVPN's ``tls_serial_0`` environment variable byte-for-byte.
"""

from __future__ import annotations

import datetime
import secrets
from dataclasses import dataclass

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_CA_COMMON_NAME = "PasarGuard OpenVPN CA"
_CA_VALIDITY_DAYS = 365 * 20
_SERVER_CERT_VALIDITY_DAYS = 365 * 20
_DEFAULT_CLIENT_VALIDITY_DAYS = 3650


@dataclass(frozen=True)
class ClientCert:
    cert_pem: str
    key_pem: str
    serial: str  # decimal string, matches OpenVPN tls_serial_0
    fingerprint: str  # hex-encoded SHA-256 of the DER certificate
    not_after: datetime.datetime


def _pem_private_key(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


def _pem_cert(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _random_serial() -> int:
    # Positive 159-bit serial (RFC 5280 requires <= 20 octets, non-negative).
    return secrets.randbits(159) + 1


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def generate_ca() -> tuple[str, str]:
    """Return ``(ca_cert_pem, ca_key_pem)`` for a fresh EC P-256 CA."""
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, _CA_COMMON_NAME)])
    now = _utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(_random_serial())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=_CA_VALIDITY_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )
    return _pem_cert(cert), _pem_private_key(key)


def generate_tls_crypt_key() -> str:
    """Generate an OpenVPN ``tls-crypt`` static key (V1 format)."""
    material = secrets.token_bytes(256)
    hex_lines = []
    hexstr = material.hex()
    for i in range(0, len(hexstr), 32):
        hex_lines.append(hexstr[i : i + 32])
    body = "\n".join(hex_lines)
    return "-----BEGIN OpenVPN Static key V1-----\n" f"{body}\n" "-----END OpenVPN Static key V1-----\n"


def _load_ca(ca_cert_pem: str, ca_key_pem: str) -> tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    ca_cert = x509.load_pem_x509_certificate(ca_cert_pem.encode("ascii"))
    ca_key = serialization.load_pem_private_key(ca_key_pem.encode("ascii"), password=None)
    return ca_cert, ca_key


def issue_server_cert(ca_cert_pem: str, ca_key_pem: str, cn: str) -> tuple[str, str]:
    """Issue a server certificate (EKU serverAuth) signed by the CA."""
    ca_cert, ca_key = _load_ca(ca_cert_pem, ca_key_pem)
    key = ec.generate_private_key(ec.SECP256R1())
    now = _utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(_random_serial())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=_SERVER_CERT_VALIDITY_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return _pem_cert(cert), _pem_private_key(key)


def issue_client_cert(ca_cert_pem: str, ca_key_pem: str, cn: str, days: int = _DEFAULT_CLIENT_VALIDITY_DAYS) -> ClientCert:
    """Issue a client certificate (EKU clientAuth) with ``CN=cn``."""
    ca_cert, ca_key = _load_ca(ca_cert_pem, ca_key_pem)
    key = ec.generate_private_key(ec.SECP256R1())
    now = _utcnow()
    not_after = now + datetime.timedelta(days=days)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(_random_serial())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    fingerprint = cert.fingerprint(hashes.SHA256()).hex()
    return ClientCert(
        cert_pem=_pem_cert(cert),
        key_pem=_pem_private_key(key),
        serial=str(cert.serial_number),
        fingerprint=fingerprint,
        not_after=not_after,
    )


def cert_needs_renewal(cert_pem: str | None, margin_days: int = 30) -> bool:
    """True if the certificate is missing, unparseable, or expiring within ``margin_days``."""
    if not cert_pem:
        return True
    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode("ascii"))
    except Exception:
        return True
    try:
        not_after = cert.not_valid_after_utc
    except AttributeError:  # cryptography < 42
        not_after = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc)
    return not_after - _utcnow() <= datetime.timedelta(days=margin_days)
