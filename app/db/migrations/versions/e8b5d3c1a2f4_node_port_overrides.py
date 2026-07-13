"""add port_overrides to nodes (per-node listen ports)

Lets one openvpn/wireguard core run on different listen ports across nodes.
Stored as a JSON map of core_configs.id (str) -> port. Nullable so existing
nodes are unaffected.

Revision ID: e8b5d3c1a2f4
Revises: d7a4c2e9f1b8
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "e8b5d3c1a2f4"
down_revision = "d7a4c2e9f1b8"
branch_labels = None
depends_on = None

_json_type = sa.JSON().with_variant(JSONB(none_as_null=True), "postgresql")


def upgrade() -> None:
    op.add_column("nodes", sa.Column("port_overrides", _json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("nodes", "port_overrides")
