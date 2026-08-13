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


def test_idle_sessions_get_a_timeout_even_on_an_existing_core():
    """Removing a user does not close a session they already hold.

    xray has the same property — it drops the user from its validator and
    leaves open connections alone — but there TCP keeps being remade, so it
    barely shows. A QUIC session can outlive the user's quota by far longer, so
    an idle timeout is applied when the config does not set one, bounding how
    long a removed user can keep using a session they already have.
    """
    config = _config()
    config["inbounds"][0].pop("udp_timeout", None)
    core = SingBoxConfig(config)
    assert core["inbounds"][0]["udp_timeout"] == "5m"


def test_an_explicit_timeout_is_left_alone():
    config = _config()
    config["inbounds"][0]["udp_timeout"] = "30s"
    core = SingBoxConfig(config)
    assert core["inbounds"][0]["udp_timeout"] == "30s"


def test_an_existing_core_rebuilt_from_storage_also_gets_the_timeout():
    """Cores are rebuilt with validation skipped, which is where this was missed.

    Applying the default only during validation meant it reached cores created
    after the change and no others — leaving every core already running without
    the one setting that bounds how long a removed user keeps a session.
    """
    stored = SingBoxConfig(_config()).to_json()
    stored["config"]["inbounds"][0].pop("udp_timeout", None)

    restored = SingBoxConfig.from_json(stored)
    assert restored["inbounds"][0]["udp_timeout"] == "5m"


def _vless(**over):
    inbound = {
        "type": "vless", "tag": "vl", "listen": "::", "listen_port": 8443,
        "users": [{"name": "seed", "uuid": "11111111-2222-3333-4444-555555555555"}],
        "tls": {"enabled": True, "server_name": "tt.example.ir",
                "certificate_path": "/c.pem", "key_path": "/k.pem"},
    }
    inbound.update(over)
    config = _config()
    config["inbounds"] = [inbound]
    return config


def test_vless_is_described_for_the_link_builder():
    """The panel already builds vless links; the core only has to name things
    the way the existing builder expects."""
    meta = SingBoxConfig(_vless()).inbounds_by_tag["vl"]
    assert meta["protocol"] == "vless"
    assert meta["port"] == 8443
    assert meta["tls"] == "tls"
    assert meta["network"] == "tcp"          # no transport block means plain tcp
    assert meta["sni"] == ["tt.example.ir"]


def test_a_transport_becomes_the_network():
    meta = SingBoxConfig(_vless(transport={"type": "ws", "path": "/x"})).inbounds_by_tag["vl"]
    assert meta["network"] == "ws"


def test_stream_protocols_may_run_without_tls():
    """Rejecting plaintext here would refuse a valid config: vless behind a
    reverse proxy that terminates TLS is ordinary. Only QUIC needs it."""
    core = SingBoxConfig(_vless(tls={"enabled": False}))
    assert core.inbounds_by_tag["vl"]["tls"] == "none"


def test_hysteria2_still_requires_tls():
    config = _config()
    config["inbounds"][0]["tls"] = {"enabled": False}
    with pytest.raises(ValueError, match="requires TLS"):
        SingBoxConfig(config)


def test_tuic_is_not_offered_because_the_panel_cannot_render_it():
    """The node can drive a tuic inbound, but ProxyProtocol has no tuic, so a
    host on one would save and then render nothing."""
    config = _config()
    config["inbounds"] = [{
        "type": "tuic", "tag": "tu", "listen_port": 443,
        "users": [{"name": "a", "uuid": "11111111-2222-3333-4444-555555555555"}],
        "tls": {"enabled": True},
    }]
    with pytest.raises(ValueError, match="no usable inbound"):
        SingBoxConfig(config)


def test_several_protocols_in_one_core():
    config = _config()
    config["inbounds"].append(_vless()["inbounds"][0])
    core = SingBoxConfig(config)
    assert sorted(core.inbounds) == ["hy2", "vl"]
    assert core.inbounds_by_tag["hy2"]["protocol"] == "hysteria"
    assert core.inbounds_by_tag["vl"]["protocol"] == "vless"


def test_protocols_reflect_the_core_not_the_class():
    """A core advertises what it serves. Returning every supported protocol
    would tell the panel a node offers vless when the core has no vless
    inbound."""
    assert SingBoxConfig(_config()).protocols == frozenset((ProxyProtocol.hysteria,))
    assert SingBoxConfig(_vless()).protocols == frozenset((ProxyProtocol.vless,))

    both = _config()
    both["inbounds"].append(_vless()["inbounds"][0])
    assert SingBoxConfig(both).protocols == frozenset(
        (ProxyProtocol.hysteria, ProxyProtocol.vless)
    )
