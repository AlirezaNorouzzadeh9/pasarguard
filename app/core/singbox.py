from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import PosixPath
from typing import Union

import commentjson

from app.models.core import CoreType
from app.models.protocol import ProxyProtocol

# Which sing-box inbound types the panel knows how to hand users to. Anything
# else in the config (tun, direct, mixed…) is left alone: it is valid sing-box,
# it just carries no users, so it produces no inbound the panel can attach a
# host to.
_PROTOCOL_BY_TYPE = {
    "hysteria2": ProxyProtocol.hysteria,
    "trojan": ProxyProtocol.trojan,
    "vless": ProxyProtocol.vless,
    "vmess": ProxyProtocol.vmess,
    "shadowsocks": ProxyProtocol.shadowsocks,
}

_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


class SingBoxConfig(dict):
    """Core config for a sing-box backend.

    The panel stores raw sing-box JSON, exactly as it stores raw xray JSON, and
    the node feeds it straight to an embedded sing-box. That means a protocol
    sing-box gains needs no panel change — only a new core config — as long as
    its inbound type is listed in ``_PROTOCOL_BY_TYPE`` so users reach it.

    Validation here is deliberately shallow: sing-box itself is the authority on
    whether a config is valid, and it reports far better errors than a
    reimplementation would. What is checked is only what the *panel* depends on
    — every inbound has a unique, usable tag, since tags are how hosts, groups
    and user assignments are keyed.
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

        self._type = CoreType.singbox
        self.exclude_inbound_tags = set(exclude_inbound_tags or set())
        self.fallbacks_inbound_tags = set(fallbacks_inbound_tags or set())
        self._inbounds: list[str] = []
        self._inbounds_by_tag: dict[str, dict] = {}
        self._protocols: frozenset[ProxyProtocol] = frozenset()

        if skip_validation:
            return

        self._validate()
        self._resolve_inbounds()

    @property
    def type(self) -> str:
        return self._type

    def _validate(self):
        if self.fallbacks_inbound_tags:
            raise ValueError("fallbacks_inbound_tags is only supported for xray cores")

        inbounds = self.get("inbounds")
        if not isinstance(inbounds, list) or not inbounds:
            raise ValueError("sing-box config must declare at least one inbound")

        seen: set[str] = set()
        for index, inbound in enumerate(inbounds):
            if not isinstance(inbound, dict):
                raise ValueError(f"inbound {index} must be an object")

            tag = str(inbound.get("tag") or "").strip()
            if not tag:
                raise ValueError(
                    f"inbound {index} has no tag; hosts, groups and users are all keyed on it"
                )
            if not _TAG_RE.fullmatch(tag):
                raise ValueError(
                    f"inbound tag {tag!r} must start with a letter or digit and contain "
                    "only letters, digits, '_', '.', or '-'"
                )
            if tag in seen:
                raise ValueError(f"duplicate inbound tag {tag!r}")
            seen.add(tag)

            if not str(inbound.get("type") or "").strip():
                raise ValueError(f"inbound {tag!r} has no type")

    def _resolve_inbounds(self):
        protocols: set[ProxyProtocol] = set()

        for inbound in self["inbounds"]:
            tag = inbound["tag"].strip()
            if tag in self.exclude_inbound_tags:
                continue

            sb_type = str(inbound.get("type") or "").strip().lower()
            protocol = _PROTOCOL_BY_TYPE.get(sb_type)
            if protocol is None:
                # A valid sing-box inbound the panel has no user model for; it
                # runs on the node but is not offered to users.
                continue

            listen_port = inbound.get("listen_port")
            tls = inbound.get("tls") or {}
            obfs = inbound.get("obfs") or {}

            metadata = {
                "tag": tag,
                "protocol": protocol.name,
                "singbox_type": sb_type,
                "network": "udp" if sb_type in ("hysteria2", "tuic") else "tcp",
                "tls": "tls" if tls.get("enabled") else "none",
                "sni": tls.get("server_name", ""),
                "alpn": tls.get("alpn") or [],
                "listen_port": listen_port,
                "port": listen_port,
            }

            # sing-box spells obfuscation differently from xray, but the link
            # builders already read xray's `finalmask` shape to emit
            # `obfs=salamander&obfs-password=…`. Translating here means link
            # generation needs no sing-box-specific branch.
            obfs_type = str(obfs.get("type") or "").strip().lower()
            obfs_password = str(obfs.get("password") or "")
            if obfs_type and obfs_password:
                metadata["finalmask"] = {
                    "udp": [{"type": obfs_type, "settings": {"password": obfs_password}}]
                }

            self._inbounds.append(tag)
            self._inbounds_by_tag[tag] = metadata
            protocols.add(protocol)

        self._protocols = frozenset(protocols)

    def to_str(self, **json_kwargs) -> str:
        return json.dumps(self, **json_kwargs)

    def to_json(self) -> dict:
        return dict(self)

    @property
    def inbounds_by_tag(self) -> dict:
        return self._inbounds_by_tag

    @property
    def inbounds(self) -> list[str]:
        return self._inbounds

    @property
    def protocols(self) -> frozenset[ProxyProtocol]:
        return self._protocols

    @classmethod
    def from_json(cls, data: dict) -> "SingBoxConfig":
        return cls(data.get("config", data))
