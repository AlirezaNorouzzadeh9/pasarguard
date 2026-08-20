"""add inbound_usages table

Revision ID: c4f8a12d7e90
Revises: e1c8a3f0b562
Create Date: 2026-08-20 14:00:00.000000

Per-inbound traffic history, mirroring node_usages: one row per 10-minute
bucket per (node, inbound tag), filled by the record_node_usages job from the
cores' own inbound>>>tag counters. The tag is stored as a plain string, not an
inbounds FK — the counters are keyed by tag on the core side, and history has
to survive an inbound being renamed or dropped from the panel config.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c4f8a12d7e90"
down_revision = "e1c8a3f0b562"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inbound_usages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("node_id", sa.Integer(), nullable=True),
        sa.Column("inbound_tag", sa.String(length=256), nullable=False),
        sa.Column("uplink", sa.BigInteger(), nullable=False),
        sa.Column("downlink", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["node_id"], ["nodes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("created_at", "node_id", "inbound_tag"),
    )
    op.create_index("ix_inbound_usages_created_at", "inbound_usages", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_inbound_usages_created_at", table_name="inbound_usages")
    op.drop_table("inbound_usages")
