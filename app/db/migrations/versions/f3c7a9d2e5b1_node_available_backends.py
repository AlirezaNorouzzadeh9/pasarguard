"""add available_backends to nodes (reported capabilities)

Stores which backend types a node reports it can run (deps installed), so the
UI can grey out cores the node cannot serve. Nullable = unknown/unreported.

Revision ID: f3c7a9d2e5b1
Revises: e8b5d3c1a2f4
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "f3c7a9d2e5b1"
down_revision = "e8b5d3c1a2f4"
branch_labels = None
depends_on = None

_json_type = sa.JSON().with_variant(JSONB(none_as_null=True), "postgresql")


def upgrade() -> None:
    op.add_column("nodes", sa.Column("available_backends", _json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("nodes", "available_backends")
