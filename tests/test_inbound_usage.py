"""Per-inbound usage: the record job writes InboundUsage rows and the crud
aggregates them per tag. Uses the same isolated-engine fixture pattern as
test_record_usages.py."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool, StaticPool

from app.db import base
from app.db.crud.node import get_inbounds_usage
from app.db.models import AdminRole, InboundUsage, Node, System
from app.jobs import record_usages
from app.models.stats import Period
from config import database_settings


class DummyNode:
    def __init__(self, node_id: int):
        self.node_id = node_id

    async def get_extra(self) -> dict[str, Any]:
        return {"usage_coefficient": 1}


def _get_test_database_url() -> str:
    test_from = os.getenv("TEST_FROM", "local").lower()
    if test_from == "local":
        return "sqlite+aiosqlite:///:memory:"
    return database_settings.url


@pytest.fixture
async def session_factory(monkeypatch: pytest.MonkeyPatch):
    database_url = _get_test_database_url()
    is_sqlite = database_url.startswith("sqlite")

    engine_kwargs = {}
    connect_args = {}
    if is_sqlite:
        connect_args["check_same_thread"] = False
        engine_kwargs["poolclass"] = StaticPool
    else:
        engine_kwargs["poolclass"] = NullPool

    engine = create_async_engine(database_url, connect_args=connect_args, **engine_kwargs)
    async with engine.begin() as conn:
        await conn.run_sync(base.Base.metadata.drop_all)
        await conn.run_sync(base.Base.metadata.create_all)

    async with async_sessionmaker(bind=engine, expire_on_commit=False)() as seed_session:
        seed_session.add(AdminRole(name="owner", is_owner=True, permissions={}, limits={}, features={}, access={}))
        await seed_session.commit()

    factory = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)

    class TestGetDB:
        def __init__(self):
            self.db = factory()

        async def __aenter__(self):
            return self.db

        async def __aexit__(self, exc_type, exc_value, traceback):
            if isinstance(exc_value, SQLAlchemyError):
                await self.db.rollback()
            await self.db.close()

    monkeypatch.setattr(record_usages, "engine", engine)
    monkeypatch.setattr(record_usages, "GetDB", TestGetDB)

    yield factory

    async with engine.begin() as conn:
        await conn.run_sync(base.Base.metadata.drop_all)
    await engine.dispose()


def test_process_inbounds_stats_response_aggregates_per_tag():
    stats_response = SimpleNamespace(
        stats=[
            SimpleNamespace(name="vless-in", type="uplink", value=10),
            SimpleNamespace(name="vless-in", type="downlink", value=40),
            SimpleNamespace(name="vless-in", type="uplink", value=5),
            SimpleNamespace(name="trojan-in", type="downlink", value=7),
            SimpleNamespace(name="zero-in", type="uplink", value=0),  # filtered out
        ]
    )
    result = {p["tag"]: (p["up"], p["down"]) for p in record_usages._process_inbounds_stats_response(stats_response)}
    assert result == {"vless-in": (15, 40), "trojan-in": (0, 7)}


@pytest.mark.asyncio
async def test_record_node_usages_writes_inbound_rows(monkeypatch: pytest.MonkeyPatch, session_factory):
    async with session_factory() as session:
        node = Node(
            name="node-1",
            address="10.0.0.1",
            port=1000,
            api_port=1001,
            server_ca="ca1",
            api_key="key1",
            core_config_id=None,
        )
        system = System(uplink=0, downlink=0)
        session.add_all([node, system])
        await session.flush()
        node_id = node.id
        await session.commit()

    nodes = [(node_id, DummyNode(node_id))]
    monkeypatch.setattr(record_usages.node_manager, "get_healthy_nodes", AsyncMock(return_value=nodes))

    async def fake_get_outbounds_stats(_: DummyNode):
        return [{"up": 25, "down": 55}]

    async def fake_get_inbounds_stats(_: DummyNode):
        return [{"tag": "vless-in", "up": 20, "down": 50}, {"tag": "trojan-in", "up": 5, "down": 5}]

    monkeypatch.setattr(record_usages, "get_outbounds_stats", fake_get_outbounds_stats)
    monkeypatch.setattr(record_usages, "get_inbounds_stats", fake_get_inbounds_stats)
    monkeypatch.setattr(record_usages.usage_settings, "disable_recording_node_usage", False)

    # Two runs in the same 10-minute bucket must accumulate via the upsert.
    await record_usages.record_node_usages()
    await record_usages.record_node_usages()

    async with session_factory() as session:
        rows = (
            await session.execute(select(InboundUsage.inbound_tag, InboundUsage.uplink, InboundUsage.downlink))
        ).all()
        per_tag = {row.inbound_tag: (row.uplink, row.downlink) for row in rows}
        assert per_tag == {"vless-in": (40, 100), "trojan-in": (10, 10)}


@pytest.mark.asyncio
async def test_get_inbounds_usage_groups_by_tag(session_factory):
    base_time = datetime(2026, 8, 20, 10, 0, tzinfo=UTC).replace(tzinfo=None)
    async with session_factory() as session:
        node = Node(
            name="node-1",
            address="10.0.0.1",
            port=1000,
            api_port=1001,
            server_ca="ca1",
            api_key="key1",
            core_config_id=None,
        )
        node2 = Node(
            name="node-2",
            address="10.0.0.2",
            port=1001,
            api_port=1002,
            server_ca="ca2",
            api_key="key2",
            core_config_id=None,
        )
        session.add_all([node, node2])
        await session.flush()
        n1, n2 = node.id, node2.id
        session.add_all(
            [
                InboundUsage(created_at=base_time, node_id=n1, inbound_tag="vless-in", uplink=10, downlink=100),
                InboundUsage(
                    created_at=base_time + timedelta(minutes=10),
                    node_id=n1,
                    inbound_tag="vless-in",
                    uplink=5,
                    downlink=50,
                ),
                InboundUsage(created_at=base_time, node_id=n2, inbound_tag="vless-in", uplink=1, downlink=2),
                InboundUsage(created_at=base_time, node_id=n1, inbound_tag="trojan-in", uplink=3, downlink=4),
            ]
        )
        await session.commit()

    start = datetime(2026, 8, 20, 10, 0, tzinfo=UTC)
    end = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)

    async with session_factory() as session:
        result = await get_inbounds_usage(session, start, end, Period.hour)
        assert set(result.stats.keys()) == {"vless-in", "trojan-in"}
        # Same hour bucket: tags summed across nodes.
        vless = result.stats["vless-in"]
        assert len(vless) == 1
        assert (vless[0].uplink, vless[0].downlink) == (16, 152)
        trojan = result.stats["trojan-in"]
        assert (trojan[0].uplink, trojan[0].downlink) == (3, 4)

        # node_id narrows to one node.
        only_n2 = await get_inbounds_usage(session, start, end, Period.hour, node_id=n2)
        assert set(only_n2.stats.keys()) == {"vless-in"}
        assert (only_n2.stats["vless-in"][0].uplink, only_n2.stats["vless-in"][0].downlink) == (1, 2)
