"""add openvpn support: settings column, host overrides, coretype enum value

Revision ID: a7f3c1e9d0b2
Revises: f976bfcf4738
Create Date: 2026-07-12 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


revision = "a7f3c1e9d0b2"
down_revision = "f976bfcf4738"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Add the "openvpn" value to the postgres coretype enum.
    #    ALTER TYPE ... ADD VALUE must run outside a transaction block.
    if bind.engine.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE coretype ADD VALUE IF NOT EXISTS 'openvpn'")

    # 2. Panel-wide OpenVPN PKI material on the settings singleton.
    op.add_column(
        "settings",
        sa.Column("openvpn", sa.JSON(), nullable=False, server_default="{}"),
    )

    # 3. Per-host OpenVPN client overrides.
    op.add_column("hosts", sa.Column("openvpn_overrides", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "openvpn_overrides")
    op.drop_column("settings", "openvpn")
    # The postgres enum value is intentionally left in place; removing an enum
    # value is not supported without recreating the type.
