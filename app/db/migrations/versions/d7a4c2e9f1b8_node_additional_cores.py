"""add additional_core_config_ids to nodes (multi-backend)

A node can run extra cores alongside its primary ``core_config`` (e.g. openvpn +
ikev2 on one node). The extra core ids are stored as a JSON list of ints,
nullable so existing single-core nodes are unaffected.

Revision ID: d7a4c2e9f1b8
Revises: c9d1f2a3b4e5
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "d7a4c2e9f1b8"
down_revision = "c9d1f2a3b4e5"
branch_labels = None
depends_on = None

_json_type = sa.JSON().with_variant(JSONB(none_as_null=True), "postgresql")


def upgrade() -> None:
    op.add_column(
        "nodes",
        sa.Column("additional_core_config_ids", _json_type, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("nodes", "additional_core_config_ids")
