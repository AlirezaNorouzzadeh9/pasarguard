"""SingBoxConfig: the metadata hosts read, and the two settings that fail quietly.

The interesting cases here are not malformed JSON — they are configs that are
perfectly valid to sing-box and useless to the panel. A core with no clash_api
starts and never receives a user; a core whose stats name users individually
records nothing for anyone created later. Both look healthy from the outside,
so both are rejected at save time, and both are pinned here.
"""

import pytest

from app.core.singbox import SingBoxConfig
from app.models.protocol import ProxyProtocol


def _config(**overrides) -> dict:
    config = {
        "log": {"level": "info"},
        "experimental": {
            "clash_api": {"external_controller": "127.0.0.1:9090", "secret": "s3cret"},
            "v2ray_api": {
                "listen": "127.0.0.1:8080",
                "stats": {"enabled": True, "inbounds": ["hy2"], "users": ["*"]},
            },
        },
        "inbounds": [
            {
                "type": "hysteria2",
                "tag": "hy2",
                "listen": "::",
                "listen_port": 443,
                "users": [{"name": "seed", "password": "seed-pw"}],
                "obfs": {"type": "salamander", "password": "0f1e2d3c"},
                "tls": {
                    "enabled": True,
                    "server_name": "tt.example.ir",
                    "certificate_path": "/c.pem",
                    "key_path": "/k.pem",
                },
            }
        ],
        "outbounds": [{"type": "direct", "tag": "direct"}],
    }
    config.update(overrides)
    return config


def test_inbound_is_described_the_way_hosts_expect():
    core = SingBoxConfig(_config())

    assert core.inbounds == ["hy2"]
    meta = core.inbounds_by_tag["hy2"]
    # "hysteria" rather than "hysteria2": that is the name ProxyProtocol and the
    # link builder use, and reusing it is what lets an existing host render a
    # sing-box inbound without changes.
    assert meta["protocol"] == "hysteria"
    assert meta["network"] == "hysteria"
    assert meta["port"] == 443
    assert meta["tls"] == "tls"
    assert meta["sni"] == ["tt.example.ir"]
    assert core.protocols == frozenset((ProxyProtocol.hysteria,))


def test_salamander_reaches_the_client_link():
    # The link builder reads the obfs password out of finalmask, because that is
    # where an xray hysteria inbound keeps it. Same structure, one code path.
    meta = SingBoxConfig(_config()).inbounds_by_tag["hy2"]
    assert meta["finalmask"] == {"udp": [{"type": "salamander", "settings": {"password": "0f1e2d3c"}}]}


def test_no_obfs_means_no_finalmask():
    config = _config()
    config["inbounds"][0].pop("obfs")
    assert SingBoxConfig(config).inbounds_by_tag["hy2"]["finalmask"] is None


def test_stats_naming_users_individually_is_rejected():
    """The failure this prevents is invisible at runtime.

    sing-box reads stats.users once, at startup. Name users individually and
    every user created afterwards passes traffic counted against nobody — no
    usage, no quota, no limit — while the core reports itself perfectly healthy.
    """
    config = _config()
    config["experimental"]["v2ray_api"]["stats"]["users"] = ["alice", "bob"]
    with pytest.raises(ValueError, match=r'must contain "\*"'):
        SingBoxConfig(config)


def test_stats_disabled_is_rejected():
    config = _config()
    config["experimental"]["v2ray_api"]["stats"]["enabled"] = False
    with pytest.raises(ValueError, match="no usage is recorded"):
        SingBoxConfig(config)


def test_missing_clash_api_is_rejected():
    """Without it the core starts and never receives a single user."""
    config = _config()
    config["experimental"].pop("clash_api")
    with pytest.raises(ValueError, match="clash_api"):
        SingBoxConfig(config)


def test_missing_experimental_section_is_rejected():
    config = _config()
    config.pop("experimental")
    with pytest.raises(ValueError, match="experimental"):
        SingBoxConfig(config)


def test_tls_is_required():
    config = _config()
    config["inbounds"][0]["tls"] = {"enabled": False}
    with pytest.raises(ValueError, match="requires TLS"):
        SingBoxConfig(config)


def test_obfs_without_password_is_rejected():
    config = _config()
    config["inbounds"][0]["obfs"] = {"type": "salamander"}
    with pytest.raises(ValueError, match="no password"):
        SingBoxConfig(config)


def test_duplicate_tags_are_rejected():
    config = _config()
    config["inbounds"].append(dict(config["inbounds"][0]))
    with pytest.raises(ValueError, match="duplicate inbound tag"):
        SingBoxConfig(config)


def test_unsupported_inbounds_are_left_alone_but_do_not_count():
    """A sing-box config may carry inbounds that are not for users.

    They are neither rejected nor exposed — but a config made only of them has
    nothing to give a host, and saying so now beats an empty subscription later.
    """
    config = _config()
    config["inbounds"] = [
        {"type": "mixed", "tag": "local", "listen": "127.0.0.1", "listen_port": 2080}
    ]
    with pytest.raises(ValueError, match="no usable inbound"):
        SingBoxConfig(config)

    config = _config()
    config["inbounds"].append({"type": "mixed", "tag": "local", "listen_port": 2080})
    core = SingBoxConfig(config)
    assert core.inbounds == ["hy2"]


def test_excluding_every_inbound_is_rejected():
    """A core with nothing left to offer is a mistake, not an empty result.

    Returning no inbounds would save cleanly and then produce subscriptions
    with nothing in them, which is a much later and much vaguer failure.
    """
    with pytest.raises(ValueError, match="no usable inbound"):
        SingBoxConfig(_config(), exclude_inbound_tags={"hy2"})


def test_excluding_one_of_several_keeps_the_rest():
    config = _config()
    second = dict(config["inbounds"][0])
    second["tag"] = "hy2-alt"
    second["listen_port"] = 8443
    config["inbounds"].append(second)

    core = SingBoxConfig(config, exclude_inbound_tags={"hy2"})
    assert core.inbounds == ["hy2-alt"]
    assert core.inbounds_by_tag["hy2-alt"]["port"] == 8443


def test_round_trip_keeps_resolved_inbounds():
    """Workers rebuild cores from this without re-validating."""
    core = SingBoxConfig(_config())
    restored = SingBoxConfig.from_json(core.to_json())
    assert restored.inbounds == core.inbounds
    assert restored.inbounds_by_tag == core.inbounds_by_tag
    assert restored.type == core.type
