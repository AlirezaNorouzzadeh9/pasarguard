import pytest

from app.core.singbox import SingBoxConfig
from app.models.core import CoreType
from app.models.protocol import ProxyProtocol

HYSTERIA2 = {
    "log": {"level": "warn"},
    "inbounds": [
        {
            "type": "hysteria2",
            "tag": "hy2-de",
            "listen": "0.0.0.0",
            "listen_port": 8443,
            "users": [],
            "obfs": {"type": "salamander", "password": "obfs-secret"},
            "tls": {"enabled": True, "server_name": "node.example.com"},
        }
    ],
    "outbounds": [{"type": "direct", "tag": "direct"}],
}


def test_resolves_inbound_and_protocol():
    cfg = SingBoxConfig(HYSTERIA2)

    assert cfg.type == CoreType.singbox
    assert cfg.inbounds == ["hy2-de"]
    assert cfg.protocols == frozenset({ProxyProtocol.hysteria})

    meta = cfg.inbounds_by_tag["hy2-de"]
    assert meta["protocol"] == "hysteria"
    assert meta["singbox_type"] == "hysteria2"
    assert meta["network"] == "udp"
    assert meta["tls"] == "tls"
    assert meta["sni"] == "node.example.com"
    assert meta["port"] == 8443


def test_obfs_is_translated_into_the_finalmask_shape_links_already_read():
    """The link builders emit obfs from xray's `finalmask`; sing-box spells it
    differently, so the core translates rather than making links special-case it."""
    meta = SingBoxConfig(HYSTERIA2).inbounds_by_tag["hy2-de"]

    assert meta["finalmask"] == {
        "udp": [{"type": "salamander", "settings": {"password": "obfs-secret"}}]
    }


def test_inbound_without_obfs_has_no_finalmask():
    config = {**HYSTERIA2, "inbounds": [{**HYSTERIA2["inbounds"][0]}]}
    config["inbounds"][0].pop("obfs")

    assert "finalmask" not in SingBoxConfig(config).inbounds_by_tag["hy2-de"]


def test_untagged_inbound_is_rejected():
    config = {"inbounds": [{"type": "hysteria2", "listen_port": 8443}], "outbounds": []}

    with pytest.raises(ValueError, match="no tag"):
        SingBoxConfig(config)


def test_duplicate_tags_are_rejected():
    inbound = HYSTERIA2["inbounds"][0]
    config = {"inbounds": [inbound, {**inbound, "listen_port": 8444}], "outbounds": []}

    with pytest.raises(ValueError, match="duplicate"):
        SingBoxConfig(config)


def test_config_without_inbounds_is_rejected():
    with pytest.raises(ValueError, match="at least one inbound"):
        SingBoxConfig({"outbounds": [{"type": "direct"}]})


def test_unknown_inbound_type_runs_but_carries_no_users():
    """A tun/direct inbound is valid sing-box; it simply is not offered to users."""
    config = {
        "inbounds": [
            HYSTERIA2["inbounds"][0],
            {"type": "mixed", "tag": "local-mixed", "listen": "127.0.0.1", "listen_port": 2080},
        ],
        "outbounds": [{"type": "direct", "tag": "direct"}],
    }

    cfg = SingBoxConfig(config)

    assert cfg.inbounds == ["hy2-de"]
    assert "local-mixed" not in cfg.inbounds_by_tag


def test_excluded_tags_are_dropped():
    cfg = SingBoxConfig(HYSTERIA2, exclude_inbound_tags={"hy2-de"})

    assert cfg.inbounds == []
    assert cfg.protocols == frozenset()


def test_round_trips_through_json():
    cfg = SingBoxConfig(HYSTERIA2)

    restored = SingBoxConfig.from_json({"config": cfg.to_json()})

    assert restored.inbounds == cfg.inbounds
    assert restored.inbounds_by_tag == cfg.inbounds_by_tag
