import io
import zipfile

from app.models.subscription import SubscriptionInboundData

from .base import BaseSubscription


# Rendered in this order with this casing because that is what the Amnezia
# clients write themselves, and users compare files.
_AMNEZIA_KEYS = ("jc", "jmin", "jmax", "s1", "s2", "h1", "h2", "h3", "h4")
_AMNEZIA_LABELS = {"jc": "Jc", "jmin": "Jmin", "jmax": "Jmax", "s1": "S1", "s2": "S2"}


class WireGuardConfiguration(BaseSubscription):
    def __init__(self):
        self.proxy_remarks = []
        self.configs: list[tuple[str, str]] = []

    @staticmethod
    def _amnezia_lines(inbound: SubscriptionInboundData) -> dict[str, str]:
        params = getattr(inbound, "wireguard_amnezia", None) or {}
        lines: dict[str, str] = {}
        for key in _AMNEZIA_KEYS:
            value = params.get(key)
            if not value:
                continue
            lines[_AMNEZIA_LABELS.get(key, key.upper())] = str(value)
        return lines

    def _render_config(self, config_dict: dict[str, dict[str, str]]) -> str:
        """Render a structured dictionary to WireGuard .conf format."""
        output = []
        for section, params in config_dict.items():
            output.append(f"[{section}]")
            for key, value in params.items():
                if value is not None:
                    output.append(f"{key} = {value}")
            output.append("")
        return "\n".join(output).strip()

    def add(self, remark: str, address: str, inbound: SubscriptionInboundData, settings: dict):
        components = self._build_wireguard_components(remark, address, inbound, settings)
        if not components:
            return

        payload = components["payload"]

        # Structured configuration data
        config_data = {
            "Interface": {
                "PrivateKey": components["private_key"],
                "Address": ", ".join(components["peer_ips"]),
            },
            "Peer": {
                "PublicKey": payload["publickey"],
                "AllowedIPs": payload["allowedips"].replace(",", ", "),
                "Endpoint": f"{address}:{inbound.port}",
            },
        }

        # Optional Interface settings
        if mtu := payload.get("mtu"):
            config_data["Interface"]["MTU"] = str(mtu)
        if reserved := payload.get("reserved"):
            config_data["Interface"]["Reserved"] = str(reserved)
        if dns_servers := payload.get("dns"):
            if isinstance(dns_servers, str):
                config_data["Interface"]["DNS"] = dns_servers.replace(",", ", ")
            else:
                config_data["Interface"]["DNS"] = ", ".join(dns_servers)

        # AmneziaWG obfuscation. These belong to the interface and must match
        # the server exactly, or the client connects to nothing. Written in the
        # canonical Jc/Jmin/... casing the Amnezia clients expect, and placed
        # before Peer so the file reads like the ones those apps generate.
        for key, value in self._amnezia_lines(inbound).items():
            config_data["Interface"][key] = value

        # Optional Peer settings
        if preshared_key := payload.get("presharedkey"):
            config_data["Peer"]["PresharedKey"] = preshared_key
        if keepalive := payload.get("keepalive"):
            config_data["Peer"]["PersistentKeepalive"] = str(keepalive)

        config_content = self._render_config(config_data)
        self.configs.append((components["remark"], config_content))

    def render(self) -> bytes | str:
        # A single host is returned as the raw .conf so the user imports it
        # directly (no unzip step). Multiple hosts still need a zip, because
        # several WireGuard tunnels can't live in one importable .conf file.
        if len(self.configs) == 1:
            return self.configs[0][1]

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for remark, config_content in self.configs:
                hostname = remark.replace(" ", "_").replace("/", "_")
                filename = f"{hostname}.conf"
                zip_file.writestr(filename, config_content)

        zip_buffer.seek(0)
        return zip_buffer.getvalue()
