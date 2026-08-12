from __future__ import annotations

import json
from copy import deepcopy
from pathlib import PosixPath

import commentjson

from app.models.core import CoreType
from app.models.protocol import ProxyProtocol

# Only Hysteria2 for now. The node can replace an inbound's users at runtime
# through PUT /inbounds/{tag}/users, and that endpoint is generic, but only the
# Hysteria2 inbound has been given the exported UpdateUsers it calls. Listing a
# protocol here before the node can drive it would produce a core that looks
# assignable and then cannot take a user.
_SUPPORTED_INBOUNDS = frozenset(("hysteria2",))

# sing-box inbound type -> the protocol name the panel builds links for.
# "hysteria" is what ProxyProtocol and LinkGenerator._build_hysteria call it;
# both emit hysteria2:// URIs.
_PROTOCOL_BY_TYPE = {"hysteria2": "hysteria"}

_PROTOCOLS = frozenset((ProxyProtocol.hysteria,))


class SingBoxConfig(dict):
    """Core config for a sing-box backend.

    The config stored here is the sing-box config the node runs, verbatim. What
    this class adds is the inbound metadata the rest of the panel expects, in
    the same shape :class:`XRayConfig` produces — so hosts, subscription
    rendering and link generation work against a sing-box core without knowing
    it is one.

    Two settings are enforced that sing-box itself treats as optional, because
    without them the core runs, reports healthy, and quietly fails to do its
    job:

    ``experimental.clash_api``
        How the node adds and removes users. Missing, the core starts and then
        never receives a single user.

    ``experimental.v2ray_api.stats`` with ``"*"`` in ``users``
        Where per-user traffic comes from. That list is read once at startup,
        so naming users individually means anyone created later passes traffic
        counted against nobody — no usage, no quota, no limit. Rejecting it at
        save time is the only point where it is still cheap to notice.
    """

    def __init__(
        self,
        config: dict | str | PosixPath | None = None,
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

        if skip_validation:
            return

        self._apply_session_defaults()
        self._validate()
        self._resolve_inbounds()

    @property
    def type(self) -> str:
        return self._type

    # ---------------------------------------------------------------- validate

    def _validate(self):
        if self.fallbacks_inbound_tags:
            raise ValueError("fallbacks_inbound_tags is only supported for xray cores")

        inbounds = self.get("inbounds")
        if not isinstance(inbounds, list) or not inbounds:
            raise ValueError("config must contain a non-empty 'inbounds' list")

        self._validate_experimental()

        seen_tags: set[str] = set()
        usable = 0
        for index, inbound in enumerate(inbounds):
            if not isinstance(inbound, dict):
                raise ValueError(f"inbounds[{index}] must be an object")  # noqa: TRY004 - pydantic renders ValueError as a 422; TypeError would escape as a 500

            inbound_type = str(inbound.get("type") or "").strip()
            tag = str(inbound.get("tag") or "").strip()
            if not tag:
                raise ValueError(f"inbounds[{index}] is missing 'tag'")
            if tag in seen_tags:
                raise ValueError(f"duplicate inbound tag '{tag}'")
            seen_tags.add(tag)

            # Anything else in the config is left alone — a sing-box config may
            # legitimately carry inbounds the panel does not hand to users.
            if inbound_type not in _SUPPORTED_INBOUNDS:
                continue
            if tag in self.exclude_inbound_tags:
                continue

            self._validate_inbound(inbound, tag)
            usable += 1

        if usable == 0:
            supported = ", ".join(sorted(_SUPPORTED_INBOUNDS))
            raise ValueError(f"config has no usable inbound; supported types: {supported}")

    def _validate_experimental(self):
        experimental = self.get("experimental")
        if not isinstance(experimental, dict):
            raise ValueError(  # noqa: TRY004 - pydantic renders ValueError as a 422; TypeError would escape as a 500
                "config must contain an 'experimental' section with clash_api and v2ray_api; "
                "without it the node cannot add users or read their usage"
            )

        clash_api = experimental.get("clash_api")
        if not isinstance(clash_api, dict) or not str(clash_api.get("external_controller") or "").strip():
            raise ValueError(
                "experimental.clash_api.external_controller is required — "
                "it is how the node adds and removes users on this core"
            )

        v2ray_api = experimental.get("v2ray_api")
        if not isinstance(v2ray_api, dict) or not str(v2ray_api.get("listen") or "").strip():
            raise ValueError(
                "experimental.v2ray_api.listen is required — it is where per-user usage is read from"
            )

        stats = v2ray_api.get("stats")
        if not isinstance(stats, dict) or not stats.get("enabled"):
            raise ValueError("experimental.v2ray_api.stats.enabled must be true, or no usage is recorded")

        users = stats.get("users")
        if not isinstance(users, list) or "*" not in users:
            raise ValueError(
                'experimental.v2ray_api.stats.users must contain "*". '
                "That list is read once at startup, so naming users individually means every user "
                "created afterwards passes traffic that is counted against nobody"
            )

    # How long an idle Hysteria2 session is kept before sing-box drops it.
    #
    # Removing a user stops them authenticating again but does not close a
    # session they already hold — xray behaves the same way, dropping a user
    # from its validator and leaving open connections alone. There it is barely
    # visible, because TCP connections keep being remade; a QUIC session can sit
    # open far longer, so a user who ran out of data could keep using one.
    #
    # Ending an idle session forces a fresh handshake, which now fails. Applied
    # to cores that do not set it rather than only to new ones, since the cores
    # that most need it are the ones already running.
    _DEFAULT_UDP_TIMEOUT = "5m"

    @classmethod
    def _validate_inbound(cls, inbound: dict, tag: str):
        port = inbound.get("listen_port")
        if not isinstance(port, int) or port <= 0 or port > 65535:
            raise ValueError(f"inbound '{tag}' needs a 'listen_port' between 1 and 65535")

        tls = inbound.get("tls")
        if not isinstance(tls, dict) or not tls.get("enabled"):
            raise ValueError(f"inbound '{tag}' requires TLS; hysteria2 will not start without it")

        obfs = inbound.get("obfs")
        if obfs is not None:
            if not isinstance(obfs, dict):
                raise ValueError(f"inbound '{tag}': obfs must be an object")
            if str(obfs.get("type") or "").strip() != "salamander":
                raise ValueError(f"inbound '{tag}': the only supported obfs type is salamander")
            if not str(obfs.get("password") or "").strip():
                raise ValueError(f"inbound '{tag}': obfs is set but has no password")

    # ---------------------------------------------------------------- inbounds

    def _resolve_inbounds(self):
        for inbound in self["inbounds"]:
            inbound_type = str(inbound.get("type") or "").strip()
            tag = str(inbound.get("tag") or "").strip()
            if inbound_type not in _SUPPORTED_INBOUNDS or tag in self.exclude_inbound_tags:
                continue
            if tag in self._inbounds_by_tag:
                continue
            self._inbounds.append(tag)
            self._inbounds_by_tag[tag] = self._inbound_metadata(inbound, tag, inbound_type)

    @staticmethod
    def _inbound_metadata(inbound: dict, tag: str, inbound_type: str) -> dict:
        """Describe the inbound the way the rest of the panel expects.

        Deliberately the same keys XRayConfig emits. The link builder, the host
        layer and the subscription renderers already handle a "hysteria"
        inbound; matching their shape means none of them need to learn that
        sing-box exists.
        """
        tls = inbound.get("tls") or {}
        server_name = str(tls.get("server_name") or "").strip()

        return {
            "tag": tag,
            "protocol": _PROTOCOL_BY_TYPE[inbound_type],
            "port": inbound["listen_port"],
            # xray reports a hysteria inbound's network as "hysteria"; the link
            # builder keys its transport handling off this.
            "network": "hysteria",
            "tls": "tls",
            "sni": [server_name] if server_name else [],
            "host": [],
            "path": "",
            "header_type": "",
            "is_fallback": False,
            "fallbacks": [],
            "finalmask": SingBoxConfig._finalmask(inbound),
        }

    @staticmethod
    def _finalmask(inbound: dict) -> dict | None:
        """Carry salamander obfuscation into the client link.

        The link builder reads the obfs password out of finalmask rather than
        from the inbound directly, because that is where an xray hysteria
        inbound keeps it. Emitting the same structure keeps one code path.
        """
        obfs = inbound.get("obfs")
        if not isinstance(obfs, dict):
            return None
        password = str(obfs.get("password") or "").strip()
        if not password:
            return None
        return {"udp": [{"type": "salamander", "settings": {"password": password}}]}

    # ------------------------------------------------------------------ dunder

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
        return _PROTOCOLS

    def to_json(self) -> dict:
        return {
            "type": self.type,
            "config": dict(self),
            "exclude_inbound_tags": list(self.exclude_inbound_tags),
            "fallbacks_inbound_tags": [],
            "inbounds": self.inbounds,
            "inbounds_by_tag": self.inbounds_by_tag,
        }

    @classmethod
    def from_json(cls, data: dict) -> SingBoxConfig:
        instance = cls(
            config=data.get("config", {}),
            exclude_inbound_tags=set(data.get("exclude_inbound_tags") or []),
            skip_validation=True,
        )
        # Validation is skipped here — this rebuilds a core that was already
        # accepted — but the idle timeout still has to be applied, or it would
        # only ever reach cores created after this change. The cores that need
        # it most are the ones already running.
        instance._apply_session_defaults()
        if "inbounds" in data:
            instance._inbounds = data["inbounds"]
        if "inbounds_by_tag" in data:
            instance._inbounds_by_tag = data["inbounds_by_tag"]
        return instance

    def _apply_session_defaults(self) -> None:
        """Set the idle timeout on any inbound that does not name one.

        Kept separate from validation so it runs on both paths: a core being
        saved, and a core being rebuilt from storage.
        """
        for inbound in self.get("inbounds") or []:
            if not isinstance(inbound, dict):
                continue
            if str(inbound.get("type") or "").strip() in _SUPPORTED_INBOUNDS:
                inbound.setdefault("udp_timeout", self._DEFAULT_UDP_TIMEOUT)

    def copy(self):
        return deepcopy(self)
