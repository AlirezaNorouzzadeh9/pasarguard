"""add backend_versions to nodes (reported installed versions)

Stores the installed version per backend the node reports, e.g.
{"xray":"26.3.27","openvpn":"2.6.3"}. Nullable.

Revision ID: a1e6b8c4d9f2
Revises: f3c7a9d2e5b1
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "a1e6b8c4d9f2"
down_revision = "f3c7a9d2e5b1"
branch_labels = None
depends_on = None

_json_type = sa.JSON().with_variant(JSONB(none_as_null=True), "postgresql")


def upgrade() -> None:
    op.add_column("nodes", sa.Column("backend_versions", _json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("nodes", "backend_versions")
