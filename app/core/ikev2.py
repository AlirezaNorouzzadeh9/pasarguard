from __future__ import annotations

import json
import re
from copy import deepcopy
from ipaddress import ip_network
from pathlib import PosixPath
from typing import Union

import commentjson
from cryptography import x509
from cryptography.hazmat.primitives import serialization

from app.models.core import CoreType
from app.models.protocol import ProxyProtocol

_IKEV2_PROTOCOLS = frozenset((ProxyProtocol.ikev2,))
_IKEV2_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_DEFAULT_IKE_PROPOSALS = ["aes256-sha256-modp2048", "aes128-sha256-modp2048"]
_DEFAULT_ESP_PROPOSALS = ["aes256-sha256", "aes128-sha256"]


def _require_pem_cert(value: str, field: str) -> str:
    value = str(value or "").strip()
    if not value:
        raise ValueError(f"{field} is required")
    try:
        x509.load_pem_x509_certificate(value.encode("ascii"))
    except Exception as exc:
        raise ValueError(f"{field} is not a valid PEM certificate") from exc
    return value


def _require_pem_key(value: str, field: str) -> str:
    value = str(value or "").strip()
    if not value:
        raise ValueError(f"{field} is required")
    try:
        serialization.load_pem_private_key(value.encode("ascii"), password=None)
    except Exception as exc:
        raise ValueError(f"{field} is not a valid PEM private key") from exc
    return value


class IKEv2Config(dict):
    """Core config for an IKEv2/IPsec (strongSwan) server backend.

    Shape mirrors :class:`OpenVPNConfig`. Auth is EAP-MSCHAPv2 (user/pass), so
    there is no per-user certificate material — only the shared server
    certificate the node presents. The CA/server certificate material is
    injected by ``ensure_ikev2_core_material`` (operation layer) before
    validation, so ``_validate`` only checks presence and parseability and stays
    pure/sync (it also runs on node workers reconstructing state from NATS KV).
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

        self._type = CoreType.ikev2
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
        if not _IKEV2_TAG_RE.fullmatch(inbound_tag):
            raise ValueError(
                "inbound_tag must start with a letter or digit "
                "and contain only letters, digits, '_', '.', or '-'"
            )
        self["inbound_tag"] = inbound_tag

        server_addr = str(self.get("server_addr") or "").strip()
        if not server_addr:
            raise ValueError("server_addr is required (the public IP or hostname clients connect to)")
        self["server_addr"] = server_addr

        # Identity presented in the server certificate / verified as the remote ID
        # by the client. Defaults to the server address.
        identity = str(self.get("identity") or server_addr).strip()
        self["identity"] = identity

        pool = str(self.get("pool") or "").strip()
        if not pool:
            raise ValueError("pool is required")
        self["pool"] = str(ip_network(pool, strict=False))

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

        # Server-side certificate material (injected by ensure_ikev2_core_material).
        self["ca_cert"] = _require_pem_cert(self.get("ca_cert"), "ca_cert")
        self["server_cert"] = _require_pem_cert(self.get("server_cert"), "server_cert")
        self["server_key"] = _require_pem_key(self.get("server_key"), "server_key")

    def _resolve_inbounds(self):
        inbound_tag = self["inbound_tag"]
        # server_key / ca_key must never appear in inbound metadata — it is
        # broadcast to workers/subscription. Only client-facing values (the CA
        # cert to trust the server, the address and identity) are exposed.
        metadata = {
            "tag": inbound_tag,
            "protocol": "ikev2",
            "network": "udp",
            "tls": "none",
            "server_addr": self["server_addr"],
            "identity": self["identity"],
            "pool": self["pool"],
            "egress_interface": self.get("egress_interface", ""),
            "dns": list(self.get("dns", [])),
            "ca_cert": self.get("ca_cert", ""),
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
        return _IKEV2_PROTOCOLS
