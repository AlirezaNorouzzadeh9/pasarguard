"""add openvpn settings column

Revision ID: c3f1a92d5e7b
Revises: b8e4c07d19a3
Create Date: 2026-08-05 00:00:00.000000

Holds the panel-wide OpenVPN PKI: the CA certificate and key, the tls-crypt key
and the client certificate validity. Empty until the first OpenVPN core is
saved, which is what mints the material, so existing rows need no backfill.

Separate from b8e4c07d19a3 rather than folded into it: that revision has already
been applied, and an edit to an applied migration never runs again.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3f1a92d5e7b"
down_revision = "b8e4c07d19a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "settings",
        sa.Column("openvpn", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("settings", "openvpn")
