import io
import re
import uuid
import zipfile

from app.models.subscription import SubscriptionInboundData

from .base import BaseSubscription

_NAMESPACE = uuid.UUID("6ba7b812-9dad-11d1-80b4-00c04fd430c8")


def _pem_to_der_b64(pem: str) -> str:
    """Extract the base64 DER body from a PEM certificate (no headers/newlines)."""
    body = re.sub(r"-----(BEGIN|END) CERTIFICATE-----", "", pem or "")
    return "".join(body.split())


def _ca_common_name(ca_der_b64: str) -> str:
    try:
        import base64

        from cryptography import x509

        cert = x509.load_der_x509_certificate(base64.b64decode(ca_der_b64))
        attrs = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
        return attrs[0].value if attrs else ""
    except Exception:
        return ""


def _plist_escape(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


class IKEv2Configuration(BaseSubscription):
    def __init__(self):
        self.proxy_remarks = []
        self.configs: list[tuple[str, str, bytes]] = []  # (filename, kind, bytes)
        # Plain connection details, surfaced inline on the subscription page.
        self.details: list[dict[str, str]] = []

    def add(self, remark: str, address: str, inbound: SubscriptionInboundData, settings: dict):
        username = (settings or {}).get("username")
        password = (settings or {}).get("password")
        ca_cert = inbound.ikev2_ca_cert
        if not username or not password or not ca_cert:
            return

        validated_remark = self._remark_validation(remark)
        self.proxy_remarks.append(validated_remark)

        # RemoteAddress (where to connect) is the per-location host address, so
        # you can point the host at any node / change the IP freely.
        # RemoteIdentifier (what the client validates the server cert against) is
        # the core's FIXED identity — decoupled from the IP — so the same shared
        # server certificate validates no matter which node/IP the host points to.
        host_addr = (address or "").strip()
        server = host_addr or inbound.ikev2_server_addr
        identity = inbound.ikev2_identity or inbound.ikev2_server_addr or host_addr
        self.details.append(
            {
                "remark": validated_remark,
                "server": server,
                "identity": identity,
                "username": str(username),
                "password": str(password),
            }
        )
        ca_der = _pem_to_der_b64(ca_cert)
        ca_cn = _ca_common_name(ca_der)

        # Deterministic UUIDs so re-downloading updates the profile in place.
        prof_uuid = str(uuid.uuid5(_NAMESPACE, f"pg-ikev2-profile-{username}-{inbound.inbound_tag}")).upper()
        vpn_uuid = str(uuid.uuid5(_NAMESPACE, f"pg-ikev2-vpn-{username}-{inbound.inbound_tag}")).upper()
        ca_uuid = str(uuid.uuid5(_NAMESPACE, f"pg-ikev2-ca-{ca_cn or server}")).upper()

        mobileconfig = self._mobileconfig(validated_remark, server, identity, username, password, ca_der, ca_cn, prof_uuid, vpn_uuid, ca_uuid)
        self.configs.append((f"{self._safe(validated_remark)}.mobileconfig", "apple", mobileconfig.encode()))

        instructions = self._instructions(validated_remark, server, identity, username, password)
        self.configs.append((f"{self._safe(validated_remark)}-instructions.txt", "text", instructions.encode()))

    @staticmethod
    def _safe(name: str) -> str:
        return name.replace(" ", "_").replace("/", "_")

    def _mobileconfig(self, remark, server, identity, username, password, ca_der, ca_cn, prof_uuid, vpn_uuid, ca_uuid) -> str:
        r, s, i, u, p = (_plist_escape(x) for x in (remark, server, identity, username, password))
        cn = _plist_escape(ca_cn)
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.pasarguard.ikev2.ca.{ca_uuid}</string>
      <key>PayloadUUID</key><string>{ca_uuid}</string>
      <key>PayloadDisplayName</key><string>PasarGuard CA</string>
      <key>PayloadCertificateFileName</key><string>ca.cer</string>
      <key>PayloadContent</key>
      <data>{ca_der}</data>
    </dict>
    <dict>
      <key>PayloadType</key><string>com.apple.vpn.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.pasarguard.ikev2.vpn.{vpn_uuid}</string>
      <key>PayloadUUID</key><string>{vpn_uuid}</string>
      <key>PayloadDisplayName</key><string>{r}</string>
      <key>UserDefinedName</key><string>{r}</string>
      <key>VPNType</key><string>IKEv2</string>
      <key>IKEv2</key>
      <dict>
        <key>RemoteAddress</key><string>{s}</string>
        <key>RemoteIdentifier</key><string>{i}</string>
        <key>LocalIdentifier</key><string>{u}</string>
        <key>AuthenticationMethod</key><string>None</string>
        <key>ExtendedAuthEnabled</key><integer>1</integer>
        <key>AuthName</key><string>{u}</string>
        <key>AuthPassword</key><string>{p}</string>
        <key>ServerCertificateIssuerCommonName</key><string>{cn}</string>
        <key>DeadPeerDetectionRate</key><string>Medium</string>
        <key>DisableMOBIKE</key><integer>0</integer>
        <key>DisableRedirect</key><integer>0</integer>
        <key>EnablePFS</key><integer>0</integer>
      </dict>
    </dict>
  </array>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>com.pasarguard.ikev2.profile.{prof_uuid}</string>
  <key>PayloadUUID</key><string>{prof_uuid}</string>
  <key>PayloadDisplayName</key><string>{r} (IKEv2)</string>
</dict>
</plist>
"""

    def _instructions(self, remark, server, identity, username, password) -> str:
        return (
            f"IKEv2/IPsec — {remark}\n"
            f"{'=' * 40}\n\n"
            f"Server:   {server}\n"
            f"Remote ID: {identity}\n"
            f"Username: {username}\n"
            f"Password: {password}\n"
            f"Auth:     EAP (username/password)\n\n"
            "iOS / macOS:\n"
            "  Open the .mobileconfig file, install the profile, then turn the VPN on in Settings.\n\n"
            "Android:\n"
            "  Install the 'strongSwan' app. Add a profile:\n"
            f"    Server: {server}\n    VPN Type: IKEv2 EAP (Username/Password)\n"
            f"    Username: {username}\n    Password: {password}\n"
            "  Import the panel CA certificate (from the .mobileconfig or your admin) under 'CA certificate'.\n\n"
            "Windows 10/11:\n"
            "  Settings > Network > VPN > Add VPN:\n"
            "    Provider: Windows (built-in)\n"
            f"    Server name/address: {server}\n    VPN type: IKEv2\n"
            "    Sign-in info: User name and password\n"
            f"    User name: {username}\n    Password: {password}\n"
            "  Note: install/trust the panel CA in 'Trusted Root Certification Authorities' first.\n"
        )

    def render(self) -> bytes:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for filename, _kind, content in self.configs:
                zip_file.writestr(filename, content)
        zip_buffer.seek(0)
        return zip_buffer.getvalue()
