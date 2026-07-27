from __future__ import annotations

import json
import re
from copy import deepcopy
from ipaddress import ip_network
from pathlib import PosixPath
from typing import Union

import commentjson

from app.models.core import CoreType
from app.models.protocol import ProxyProtocol

# L2TP/IPsec authenticates PPP clients with username/password (CHAP), the same
# credentials the IKEv2 backend uses. v1 therefore reuses the user's IKEv2 proxy
# rather than adding a second identical proxy, so the "protocol" for user
# matching is ikev2 while the core/inbound type is l2tp.
_L2TP_PROTOCOLS = frozenset((ProxyProtocol.ikev2,))
_L2TP_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_DEFAULT_IKE_PROPOSALS = ["aes256-sha1-modp2048", "aes128-sha1-modp1024", "3des-sha1-modp1024"]
_DEFAULT_ESP_PROPOSALS = ["aes256-sha1", "aes128-sha1", "3des-sha1"]


class L2TPConfig(dict):
    """Core config for an L2TP/IPsec server backend.

    Shape mirrors :class:`IKEv2Config`, but the IPsec layer is authenticated
    with a shared pre-shared key (PSK) instead of a server certificate, and the
    L2TP/PPP layer authenticates each user with username/password. The PSK is
    injected by ``ensure_l2tp_core_material`` (operation layer) before
    validation, so ``_validate`` stays pure/sync (it also runs on node workers
    reconstructing state from NATS KV).
    """

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

        self._type = CoreType.l2tp
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

        inbound_tag = str(self.get("inbound_tag") or "").strip()
        if not inbound_tag:
            raise ValueError("inbound_tag is required")
        if not _L2TP_TAG_RE.fullmatch(inbound_tag):
            raise ValueError(
                "inbound_tag must start with a letter or digit "
                "and contain only letters, digits, '_', '.', or '-'"
            )
        self["inbound_tag"] = inbound_tag

        server_addr = str(self.get("server_addr") or "").strip()
        if not server_addr:
            raise ValueError("server_addr is required (the public IP or hostname clients connect to)")
        self["server_addr"] = server_addr

        pool = str(self.get("pool") or "").strip()
        if not pool:
            raise ValueError("pool is required")
        self["pool"] = str(ip_network(pool, strict=False))

        local_ip = str(self.get("local_ip") or "").strip()
        self["local_ip"] = local_ip

        # Optional per-node egress: route this core's subnet out a specific
        # interface on the node (e.g. an upstream wg-de tunnel). The node does
        # the policy routing; here we just validate the interface name.
        egress = str(self.get("egress_interface") or "").strip()
        if egress and not re.fullmatch(r"[A-Za-z0-9._@-]{1,15}", egress):
            raise ValueError(
                "egress_interface must be a valid interface name (letters, digits, '.', '_', '-', '@'; max 15 chars)"
            )
        self["egress_interface"] = egress

        dns = self.get("dns") or ["1.1.1.1", "8.8.8.8"]
        if not isinstance(dns, list) or not all(isinstance(d, str) for d in dns):
            raise ValueError("dns must be a list of strings")
        self["dns"] = list(dns)

        for key, default in (("ike_proposals", _DEFAULT_IKE_PROPOSALS), ("esp_proposals", _DEFAULT_ESP_PROPOSALS)):
            value = self.get(key) or default
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ValueError(f"{key} must be a list of strings")
            self[key] = list(value)

        # Shared IPsec pre-shared key (injected by ensure_l2tp_core_material).
        psk = str(self.get("psk") or "").strip()
        if not psk:
            raise ValueError("psk is required")
        self["psk"] = psk

    def _resolve_inbounds(self):
        inbound_tag = self["inbound_tag"]
        # NOTE: the PSK must never appear in inbound metadata — it is broadcast to
        # workers/subscription. Only client-facing values are exposed here; the
        # subscription renderer adds the PSK for the config file it hands the user.
        metadata = {
            "tag": inbound_tag,
            "protocol": "l2tp",
            "network": "udp",
            "tls": "none",
            "server_addr": self["server_addr"],
            "pool": self["pool"],
            "egress_interface": self.get("egress_interface", ""),
            "dns": list(self.get("dns", [])),
        }
        self._inbounds = [inbound_tag]
        self._inbounds_by_tag = {inbound_tag: metadata}

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
        return _L2TP_PROTOCOLS

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
    def from_json(cls, data: dict) -> "L2TPConfig":
        instance = cls(config=data.get("config", {}), skip_validation=True)
        if "inbounds" in data:
            instance._inbounds = data["inbounds"]
        if "inbounds_by_tag" in data:
            instance._inbounds_by_tag = data["inbounds_by_tag"]
        return instance

    def copy(self):
        return deepcopy(self)
