"""drop ikev2/l2tp cores and the per-user ip/speed limits

Revision ID: e5b1c9d3f7a4
Revises: c3f7a2b8e1d5
Create Date: 2026-08-04 00:00:00.000000

IKEv2, L2TP, ip_limit and speed_limit are removed from the panel for now; the
code that implemented them is preserved on the ``keep/ikev2-l2tp-limits``
branch so it can be reintroduced once it has been tested separately.

Existing rows have to go before the columns do: a leftover ikev2 core would
fail to load at startup (no config class handles that type any more), and its
hosts and inbounds would dangle off a tag nothing declares.
"""

import json

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e5b1c9d3f7a4"
down_revision = "c3f7a2b8e1d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    cores = conn.execute(
        sa.text("SELECT id, config FROM core_configs WHERE type IN ('ikev2', 'l2tp')")
    ).fetchall()

    if cores:
        core_ids = {row[0] for row in cores}
        tags = {tag for row in cores if (tag := _inbound_tag(row[1]))}

        for tag in tags:
            # inbounds.id is what the group association points at, so resolve it
            # before deleting the row.
            inbound_ids = [
                r[0] for r in conn.execute(sa.text("SELECT id FROM inbounds WHERE tag = :t"), {"t": tag})
            ]
            conn.execute(sa.text("DELETE FROM hosts WHERE inbound_tag = :t"), {"t": tag})
            for inbound_id in inbound_ids:
                conn.execute(
                    sa.text("DELETE FROM inbounds_groups_association WHERE inbound_id = :i"),
                    {"i": inbound_id},
                )
            conn.execute(sa.text("DELETE FROM inbounds WHERE tag = :t"), {"t": tag})

        # Detach the cores from every node, both as the primary core and inside
        # the additional-cores JSON list.
        for core_id in core_ids:
            conn.execute(
                sa.text("UPDATE nodes SET core_config_id = NULL WHERE core_config_id = :c"),
                {"c": core_id},
            )
        _strip_additional_core_ids(conn, core_ids)

        conn.execute(sa.text("DELETE FROM core_configs WHERE type IN ('ikev2', 'l2tp')"))

    with op.batch_alter_table("users") as batch:
        batch.drop_column("speed_limit")
        batch.drop_column("ip_limit")

    # PostgreSQL keeps the now-unused 'ikev2'/'l2tp' coretype enum labels. They
    # are harmless — the application never emits them again — and dropping a
    # label means recreating the type, so they are left alone on purpose.


def downgrade() -> None:
    op.add_column("users", sa.Column("ip_limit", sa.BigInteger(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("speed_limit", sa.BigInteger(), nullable=False, server_default="0"))
    # The deleted ikev2/l2tp cores, hosts and node links are NOT restored: they
    # carried certificate material and PSKs this migration does not keep.


def _inbound_tag(raw) -> str | None:
    if not raw:
        return None
    try:
        cfg = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
    except (ValueError, TypeError):
        return None
    if not isinstance(cfg, dict):
        return None
    tag = cfg.get("inbound_tag")
    return tag if isinstance(tag, str) and tag else None


def _strip_additional_core_ids(conn, dead: set[int]) -> None:
    """Remove dead core ids from every node's additional_core_config_ids list."""
    for node_id, raw in conn.execute(sa.text("SELECT id, additional_core_config_ids FROM nodes")).fetchall():
        if not raw:
            continue
        try:
            ids = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
        except (ValueError, TypeError):
            continue
        if not isinstance(ids, list):
            continue
        kept = [i for i in ids if i not in dead]
        if kept != ids:
            conn.execute(
                sa.text("UPDATE nodes SET additional_core_config_ids = :v WHERE id = :i"),
                {"v": json.dumps(kept) if kept else None, "i": node_id},
            )
