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

_OPENVPN_PROTOCOLS = frozenset((ProxyProtocol.openvpn,))
_OPENVPN_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_ALLOWED_PROTOS = frozenset(("udp", "tcp"))
_ALLOWED_CIPHERS = frozenset(
    ("AES-256-GCM", "AES-128-GCM", "AES-256-CBC", "AES-128-CBC", "CHACHA20-POLY1305")
)
_DEFAULT_DATA_CIPHERS = ["AES-256-GCM", "CHACHA20-POLY1305"]


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


class OpenVPNConfig(dict):
    """Core config for an OpenVPN server backend.

    Shape mirrors :class:`WireGuardConfig`: a single inbound whose tag is the
    ``inbound_tag``. The CA/server certificate material is injected by
    ``ensure_openvpn_core_material`` (operation layer) before validation, so
    ``_validate`` only checks presence and parseability — it stays pure/sync so
    it can also run on node workers reconstructing state from NATS KV.
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

        self._type = CoreType.openvpn
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
        if not _OPENVPN_TAG_RE.fullmatch(inbound_tag):
            raise ValueError(
                "inbound_tag must start with a letter or digit "
                "and contain only letters, digits, '_', '.', or '-'"
            )
        self["inbound_tag"] = inbound_tag

        port = self.get("port")
        if not isinstance(port, int) or port <= 0 or port > 65535:
            raise ValueError("port must be an integer between 1 and 65535")

        proto = str(self.get("proto") or "udp").strip().lower()
        if proto not in _ALLOWED_PROTOS:
            raise ValueError("proto must be one of: udp, tcp")
        self["proto"] = proto

        server_subnet = str(self.get("server_subnet") or "").strip()
        if not server_subnet:
            raise ValueError("server_subnet is required")
        self["server_subnet"] = str(ip_network(server_subnet, strict=False))

        cipher = str(self.get("cipher") or "AES-256-GCM").strip()
        if cipher not in _ALLOWED_CIPHERS:
            raise ValueError(f"cipher must be one of: {', '.join(sorted(_ALLOWED_CIPHERS))}")
        self["cipher"] = cipher

        data_ciphers = self.get("data_ciphers") or _DEFAULT_DATA_CIPHERS
        if not isinstance(data_ciphers, list) or not all(isinstance(c, str) for c in data_ciphers):
            raise ValueError("data_ciphers must be a list of strings")
        for c in data_ciphers:
            if c not in _ALLOWED_CIPHERS:
                raise ValueError(f"data_ciphers entry '{c}' is not allowed")
        self["data_ciphers"] = list(data_ciphers)

        self["auth"] = str(self.get("auth") or "SHA256").strip()

        dns = self.get("dns") or []
        if not isinstance(dns, list) or not all(isinstance(d, str) for d in dns):
            raise ValueError("dns must be a list of strings")
        self["dns"] = list(dns)

        self["extra_server_directives"] = self._clean_server_directives(
            self.get("extra_server_directives")
        )

        # Server-side PKI material (injected by ensure_openvpn_core_material).
        self["ca_cert"] = _require_pem_cert(self.get("ca_cert"), "ca_cert")
        self["server_cert"] = _require_pem_cert(self.get("server_cert"), "server_cert")
        self["server_key"] = _require_pem_key(self.get("server_key"), "server_key")

        tls_crypt_key = str(self.get("tls_crypt_key") or "").strip()
        if "OpenVPN Static key" not in tls_crypt_key:
            raise ValueError("tls_crypt_key is required and must be an OpenVPN static key")
        self["tls_crypt_key"] = tls_crypt_key

    # Directives that would run code, or clash with lines the node always emits,
    # are rejected — extra_server_directives is for safe tuning only.
    _FORBIDDEN_SERVER_DIRECTIVES = frozenset(
        (
            "script-security", "up", "down", "route-up", "route-pre-down", "ipchange",
            "client-connect", "client-disconnect", "learn-address", "tls-verify",
            "auth-user-pass-verify", "management", "management-client-auth",
            "auth-user-pass-optional", "status", "status-version", "verify-client-cert",
            "ca", "cert", "key", "dh", "tls-crypt", "tls-auth", "client-config-dir",
        )
    )

    @classmethod
    def _clean_server_directives(cls, value) -> list[str] | None:
        if value in (None, "", []):
            return None
        if not isinstance(value, list):
            raise ValueError("extra_server_directives must be a list of strings")
        cleaned: list[str] = []
        for line in value:
            if not isinstance(line, str):
                continue
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("<"):
                raise ValueError(f"directive '{line}' is not allowed")
            keyword = line.split()[0].lower()
            if keyword in cls._FORBIDDEN_SERVER_DIRECTIVES:
                raise ValueError(f"server directive '{keyword}' is not allowed")
            cleaned.append(line)
        return cleaned or None

    def _resolve_inbounds(self):
        inbound_tag = self["inbound_tag"]
        # NOTE: server_key / ca_key must never appear in inbound metadata — it is
        # broadcast to workers/subscription. Only the client-facing CA cert and
        # the shared tls-crypt key are exposed.
        metadata = {
            "tag": inbound_tag,
            "protocol": "openvpn",
            "network": self["proto"],
            "tls": "tls",
            "listen_port": self["port"],
            "cipher": self["cipher"],
            "data_ciphers": list(self["data_ciphers"]),
            "auth": self["auth"],
            "ca_cert": self.get("ca_cert", ""),
            "tls_crypt_key": self.get("tls_crypt_key", ""),
            "server_subnet": self["server_subnet"],
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
        return _OPENVPN_PROTOCOLS

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
    def from_json(cls, data: dict) -> "OpenVPNConfig":
        instance = cls(config=data.get("config", {}), skip_validation=True)
        if "inbounds" in data:
            instance._inbounds = data["inbounds"]
        if "inbounds_by_tag" in data:
            instance._inbounds_by_tag = data["inbounds_by_tag"]
        return instance

    def copy(self):
        return deepcopy(self)
