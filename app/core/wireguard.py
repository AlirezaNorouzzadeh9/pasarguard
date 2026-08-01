from __future__ import annotations

import json
import re
from copy import deepcopy
from ipaddress import ip_interface
from pathlib import PosixPath
from typing import Union

import commentjson

from app.models.core import CoreType
from app.models.protocol import ProxyProtocol
from app.utils.crypto import get_wireguard_public_key, validate_wireguard_key

_WIREGUARD_PROTOCOLS = frozenset((ProxyProtocol.wireguard,))
_WIREGUARD_INTERFACE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

# AmneziaWG obfuscation knobs. Plain WireGuard is trivially fingerprintable —
# fixed handshake size, fixed header bytes — so DPI blocks it with one rule.
# These pad the messages and randomise the headers to remove that signature.
# Every value must match on the client, so they are validated here rather than
# discovered later as a tunnel that connects and never passes a packet.
_AMNEZIA_INT_FIELDS = ("jc", "jmin", "jmax", "s1", "s2", "h1", "h2", "h3", "h4")
_AMNEZIA_HEADER_FIELDS = ("h1", "h2", "h3", "h4")


def validate_amnezia(raw) -> dict:
    """Normalise and check the AmneziaWG block; {} means plain WireGuard."""
    if raw in (None, "", {}):
        return {}
    if not isinstance(raw, dict):
        raise ValueError("amnezia must be an object")

    values: dict[str, int] = {}
    for field in _AMNEZIA_INT_FIELDS:
        value = raw.get(field)
        if value in (None, ""):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise ValueError(f"amnezia.{field} must be an integer")
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"amnezia.{field} must be an integer")
        if value < 0:
            raise ValueError(f"amnezia.{field} must not be negative")
        values[field] = value

    if not any(values.get(f) for f in _AMNEZIA_INT_FIELDS):
        return {}

    jc, jmin, jmax = values.get("jc", 0), values.get("jmin", 0), values.get("jmax", 0)
    if jc > 128:
        raise ValueError("amnezia.jc must be between 0 and 128")
    if jc:
        if not jmax:
            raise ValueError("amnezia.jmax is required when jc is set")
        if jmin > jmax:
            raise ValueError("amnezia.jmin must not exceed amnezia.jmax")
        if jmax > 1280:
            raise ValueError("amnezia.jmax must not exceed 1280")

    s1, s2 = values.get("s1", 0), values.get("s2", 0)
    if s1 > 1132 or s2 > 1188:
        raise ValueError("amnezia.s1/s2 are too large (max 1132/1188)")
    # A handshake initiation padded by s1 must not end up the same size as the
    # response, or the peers cannot tell the two message types apart.
    if s1 and s2 and s1 + 56 == s2:
        raise ValueError("amnezia.s1 + 56 must not equal amnezia.s2")

    headers = {f: values[f] for f in _AMNEZIA_HEADER_FIELDS if values.get(f)}
    if headers:
        if len(headers) != len(_AMNEZIA_HEADER_FIELDS):
            raise ValueError("amnezia.h1-h4 must all be set together")
        for field, value in headers.items():
            # 1-4 are the real WireGuard message types.
            if value < 5:
                raise ValueError(f"amnezia.{field} must be 5 or greater")
        if len(set(headers.values())) != len(headers):
            raise ValueError("amnezia.h1-h4 must all differ")

    return values


class WireGuardConfig(dict):
    def __init__(
        self,
        config: Union[dict, str, PosixPath] | None = None,
        exclude_inbound_tags: set[str] | None = None,
        fallbacks_inbound_tags: set[str] | None = None,
        skip_validation: bool = False,
    ):
        if config is None:
            config = {}
        if isinstance(config, str):
            config = commentjson.loads(config)
        if isinstance(config, dict):
            config = deepcopy(config)

        super().__init__(config)

        self._type = CoreType.wg
        self.exclude_inbound_tags = set(exclude_inbound_tags or set())
        self.fallbacks_inbound_tags = set(fallbacks_inbound_tags or set())
        self._inbounds: list[str] = []
        self._inbounds_by_tag: dict[str, dict] = {}

        if skip_validation:
            return

        self._validate()
        self._resolve_inbounds()

    @property
    def type(self) -> str:
        return self._type

    def _validate(self):
        if self.exclude_inbound_tags:
            raise ValueError("exclude_inbound_tags is only supported for xray cores")
        if self.fallbacks_inbound_tags:
            raise ValueError("fallbacks_inbound_tags is only supported for xray cores")

        interface_name = str(self.get("interface_name") or "").strip()
        if not interface_name:
            raise ValueError("interface_name is required")
        if not _WIREGUARD_INTERFACE_NAME_RE.fullmatch(interface_name):
            raise ValueError(
                "interface_name must start with a letter or digit "
                "and contain only letters, digits, '_', '.', or '-'"
            )
        self["interface_name"] = interface_name

        private_key = str(self.get("private_key") or "").strip()
        if not private_key:
            raise ValueError("private_key is required")
        self["private_key"] = validate_wireguard_key(private_key, "private_key")
        self["public_key"] = get_wireguard_public_key(self["private_key"])

        pre_shared_key = str(self.get("pre_shared_key") or "").strip()
        if pre_shared_key:
            self["pre_shared_key"] = validate_wireguard_key(pre_shared_key, "pre_shared_key")
        else:
            self.pop("pre_shared_key", None)

        listen_port = self.get("listen_port")
        if not isinstance(listen_port, int) or listen_port <= 0 or listen_port > 65535:
            raise ValueError("listen_port must be an integer between 1 and 65535")

        addresses = self.get("address")
        if not isinstance(addresses, list):
            raise ValueError("address must be a list")

        normalized_addresses: list[str] = []
        for cidr in addresses:
            if not isinstance(cidr, str) or not cidr.strip():
                raise ValueError("address entries must be valid CIDR strings")
            normalized_addresses.append(str(ip_interface(cidr.strip())))
        self["address"] = normalized_addresses

        # Optional per-node egress: route this core's subnet out a specific
        # interface on the node (e.g. an upstream wg-de tunnel). The node does
        # the policy routing; here we just validate the interface name.
        egress = str(self.get("egress_interface") or "").strip()
        if egress and not re.fullmatch(r"[A-Za-z0-9._@-]{1,15}", egress):
            raise ValueError(
                "egress_interface must be a valid interface name (letters, digits, '.', '_', '-', '@'; max 15 chars)"
            )
        self["egress_interface"] = egress

        self["amnezia"] = validate_amnezia(self.get("amnezia"))
        if not self["amnezia"]:
            self.pop("amnezia", None)

    def _resolve_inbounds(self):
        interface_name = self["interface_name"]
        metadata = {
            "tag": interface_name,
            "protocol": "wireguard",
            "network": "udp",
            "tls": "none",
            "interface_name": interface_name,
            "listen_port": self["listen_port"],
            "address": list(self["address"]),
            "egress_interface": self.get("egress_interface", ""),
            "public_key": self.get("public_key", ""),
            "private_key": self.get("private_key", ""),
            "pre_shared_key": self.get("pre_shared_key", ""),
            # Empty for a plain WireGuard core; the subscription renderer uses
            # it to decide whether clients need the AmneziaWG parameters.
            "amnezia": dict(self.get("amnezia") or {}),
        }
        self._inbounds = [interface_name]
        self._inbounds_by_tag = {interface_name: metadata}

    def to_str(self, **json_kwargs) -> str:
        return json.dumps(self, **json_kwargs)

    @property
    def inbounds_by_tag(self) -> dict:
        return self._inbounds_by_tag

    @property
    def inbounds(self) -> list[str]:
        return self._inbounds

    @property
    def protocols(self) -> frozenset[ProxyProtocol]:
        return _WIREGUARD_PROTOCOLS

    def to_json(self) -> dict:
        return {
            "type": self.type,
            "config": dict(self),
            "exclude_inbound_tags": [],
            "fallbacks_inbound_tags": [],
            "inbounds": self.inbounds,
            "inbounds_by_tag": self.inbounds_by_tag,
        }

    @classmethod
    def from_json(cls, data: dict) -> "WireGuardConfig":
        instance = cls(config=data.get("config", {}), skip_validation=True)
        if "inbounds" in data:
            instance._inbounds = data["inbounds"]
        if "inbounds_by_tag" in data:
            instance._inbounds_by_tag = data["inbounds_by_tag"]
        return instance

    def copy(self):
        return deepcopy(self)
