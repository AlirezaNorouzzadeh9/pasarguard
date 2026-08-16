import json

import pytest

from app.core.l2tp import L2TPConfig


def _cfg(**over):
    base = {
        "inbound_tag": "l2tp-main",
        "server_addr": "172.234.115.84",
        "pool": "10.31.0.0/24",
        "psk": "sharedsecret",
    }
    base.update(over)
    return L2TPConfig(base)


def test_l2tp_config_validates_and_hides_psk():
    cfg = _cfg()
    assert cfg.inbounds == ["l2tp-main"]
    meta = cfg.inbounds_by_tag["l2tp-main"]
    assert meta["protocol"] == "l2tp"
    # The PSK is a shared client secret every client needs, so it IS exposed in
    # metadata for the subscription (like IKEv2's client-facing CA cert).
    assert meta["psk"] == "sharedsecret"
    assert json.loads(cfg.to_str())["psk"] == "sharedsecret"


def test_l2tp_requires_psk_and_pool():
    with pytest.raises(ValueError):
        L2TPConfig({"inbound_tag": "l2tp-main", "server_addr": "1.2.3.4", "pool": "10.31.0.0/24"})
    with pytest.raises(ValueError):
        L2TPConfig({"inbound_tag": "l2tp-main", "server_addr": "1.2.3.4", "psk": "x"})


def test_l2tp_egress_round_trips():
    cfg = _cfg(egress_interface="de")
    assert json.loads(cfg.to_str())["egress_interface"] == "de"
    assert cfg.inbounds_by_tag["l2tp-main"]["egress_interface"] == "de"


def test_l2tp_egress_rejects_bad_name():
    with pytest.raises(ValueError):
        _cfg(egress_interface="bad name; rm -rf")


@pytest.mark.asyncio
async def test_ensure_l2tp_material_generates_psk():
    from app.utils.l2tp import ensure_l2tp_core_material

    out = await ensure_l2tp_core_material(None, {"inbound_tag": "l2tp-main", "pool": "10.31.0.0/24"})
    assert out.get("psk")
    # Idempotent — an existing PSK is kept.
    out2 = await ensure_l2tp_core_material(None, {"psk": "keepme"})
    assert out2["psk"] == "keepme"
