"""add l2tp core type

Revision ID: a7c2e94d0b13
Revises: e1c8a3f0b562
Create Date: 2026-08-16 05:00:00.000000

The L2TP backend is restored, and on MySQL/MariaDB the core type column is a
native ENUM, so the Python-side CoreType member is not enough — inserting an
l2tp core fails with "Data truncated for column 'type'". Same story (and same
fix) as e1c8a3f0b562 widening the enum for openvpn: PostgreSQL and SQLite
store the value as a string and need nothing.

The value list is written out literally rather than read from CoreType: a
migration describes the schema at one point in history, and must not change
meaning later when someone adds a core type.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "a7c2e94d0b13"
down_revision = "e1c8a3f0b562"
branch_labels = None
depends_on = None

VALUES = ("xray", "wg", "mtproto", "singbox", "openvpn", "l2tp")


def upgrade() -> None:
    if op.get_bind().engine.name != "mysql":
        return
    values = ", ".join(f"'{v}'" for v in VALUES)
    op.execute(
        f"ALTER TABLE core_configs MODIFY COLUMN type ENUM({values}) NOT NULL DEFAULT 'xray'"
    )


def downgrade() -> None:
    if op.get_bind().engine.name != "mysql":
        return
    # Narrowing would truncate any core already stored as 'l2tp'; drop those
    # cores' rows is not this migration's call, so park them on xray instead of
    # letting MySQL silently blank the column.
    op.execute("UPDATE core_configs SET type = 'xray' WHERE type = 'l2tp'")
    values = ", ".join(f"'{v}'" for v in VALUES if v != "l2tp")
    op.execute(
        f"ALTER TABLE core_configs MODIFY COLUMN type ENUM({values}) NOT NULL DEFAULT 'xray'"
    )
