import io
import zipfile

from app.models.subscription import SubscriptionInboundData

from .base import BaseSubscription


class OpenVPNConfiguration(BaseSubscription):
    def __init__(self):
        self.proxy_remarks = []
        self.configs: list[tuple[str, str]] = []

    def add(self, remark: str, address: str, inbound: SubscriptionInboundData, settings: dict):
        cert_pem = (settings or {}).get("cert_pem")
        key_pem = (settings or {}).get("private_key_pem")
        ca_cert = inbound.openvpn_ca_cert
        # Skip hosts we cannot build a complete profile for.
        if not cert_pem or not key_pem or not ca_cert:
            return

        validated_remark = self._remark_validation(remark)
        self.proxy_remarks.append(validated_remark)

        proto = (inbound.openvpn_proto or "udp").lower()
        default_port = inbound.port

        lines = ["client", "dev tun"]
        if inbound.openvpn_remote_specs:
            # Explicit per-remote endpoints. Each "host [port] [proto]" may pick
            # its own protocol/port; missing fields fall back to host defaults.
            # Always per-remote form so mixed udp/tcp works.
            for spec in inbound.openvpn_remote_specs:
                parts = spec.split()
                r_host = parts[0]
                r_port = parts[1] if len(parts) > 1 else default_port
                r_proto = parts[2].lower() if len(parts) > 2 else proto
                lines.append(f"remote {r_host} {r_port} {r_proto}")
        else:
            # Failover from the Address list: one `remote` per address. A single
            # remote keeps the classic `proto` + `remote host port` form; several
            # switch to per-remote `remote host port proto` (no global proto line)
            # so the client tries each endpoint in turn.
            remotes = inbound.openvpn_remotes or ([address] if address else [])
            if len(remotes) <= 1:
                lines.append(f"proto {proto}")
                lines.append(f"remote {remotes[0] if remotes else address} {default_port}")
            else:
                for remote in remotes:
                    lines.append(f"remote {remote} {default_port} {proto}")
        lines += [
            "resolv-retry infinite",
            "nobind",
            "persist-key",
            "persist-tun",
            "remote-cert-tls server",
        ]
        if inbound.openvpn_cipher:
            lines.append(f"cipher {inbound.openvpn_cipher}")
        if inbound.openvpn_data_ciphers:
            lines.append("data-ciphers " + ":".join(inbound.openvpn_data_ciphers))
        if inbound.openvpn_auth:
            lines.append(f"auth {inbound.openvpn_auth}")
        if inbound.openvpn_mtu:
            lines.append(f"tun-mtu {inbound.openvpn_mtu}")
        if inbound.openvpn_redirect_gateway:
            lines.append("redirect-gateway def1 bypass-dhcp")
        for dns in inbound.openvpn_dns or []:
            lines.append(f'dhcp-option DNS {dns}')
        for directive in inbound.openvpn_extra_directives or []:
            lines.append(directive)
        lines.append("verb 3")

        tls_crypt = inbound.openvpn_tls_crypt_key
        blocks = [
            "\n".join(lines),
            f"<ca>\n{ca_cert.strip()}\n</ca>",
            f"<cert>\n{cert_pem.strip()}\n</cert>",
            f"<key>\n{key_pem.strip()}\n</key>",
        ]
        if tls_crypt:
            blocks.append(f"<tls-crypt>\n{tls_crypt.strip()}\n</tls-crypt>")

        self.configs.append((validated_remark, "\n".join(blocks) + "\n"))

    def render(self) -> bytes:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for remark, config_content in self.configs:
                hostname = remark.replace(" ", "_").replace("/", "_")
                zip_file.writestr(f"{hostname}.ovpn", config_content)

        zip_buffer.seek(0)
        return zip_buffer.getvalue()
