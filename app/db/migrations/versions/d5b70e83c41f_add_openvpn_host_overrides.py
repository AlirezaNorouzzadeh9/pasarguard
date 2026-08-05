"""add openvpn host overrides

Revision ID: d5b70e83c41f
Revises: c3f1a92d5e7b
Create Date: 2026-08-05 00:00:00.000000

Per-host OpenVPN client values merged into the generated .ovpn: protocol, extra
remotes for failover, DNS, MTU, redirect-gateway and extra client directives.
Null means "use the core's values", which is what every existing host gets.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d5b70e83c41f"
down_revision = "c3f1a92d5e7b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hosts", sa.Column("openvpn_overrides", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "openvpn_overrides")
