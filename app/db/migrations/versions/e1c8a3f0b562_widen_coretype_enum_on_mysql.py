"""widen coretype enum on mysql

Revision ID: e1c8a3f0b562
Revises: d5b70e83c41f
Create Date: 2026-08-06 03:30:00.000000

b8e4c07d19a3 added "openvpn" to the core type for PostgreSQL and skipped every
other backend on the assumption that they store the column as a plain string.
That is true of SQLite but not of MySQL/MariaDB, which renders SQLEnum as a
native ENUM and rejects anything outside the value list:

    ERROR 1265 (01000): Data truncated for column 'type' at row 1

A database created fresh from the models is fine, because the ENUM is built from
the current CoreType. Only an upgraded one is short a value — which is exactly
what a production panel migrating onto this fork is. Found on a restored copy of
a real MariaDB panel, where creating an OpenVPN core was impossible.

The value list is written out literally rather than read from CoreType: a
migration describes the schema at one point in history, and must not change
meaning later when someone adds a core type.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "e1c8a3f0b562"
down_revision = "d5b70e83c41f"
branch_labels = None
depends_on = None

VALUES = ("xray", "wg", "mtproto", "singbox", "openvpn")


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
    # Narrowing would truncate any core already stored as 'openvpn', so move
    # those back to xray first rather than let MySQL silently blank them.
    op.execute("UPDATE core_configs SET type = 'xray' WHERE type = 'openvpn'")
    values = ", ".join(f"'{v}'" for v in VALUES if v != "openvpn")
    op.execute(
        f"ALTER TABLE core_configs MODIFY COLUMN type ENUM({values}) NOT NULL DEFAULT 'xray'"
    )
