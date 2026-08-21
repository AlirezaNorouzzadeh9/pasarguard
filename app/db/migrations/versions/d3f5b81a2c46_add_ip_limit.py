"""add ip_limit to users and templates

Revision ID: d3f5b81a2c46
Revises: f1a2b3c4d5e6
Create Date: 2026-08-21 18:30:00.000000

How many connections a user may hold at once, across every backend and every
node. Nullable, and null (or zero) means no limit — which is what every existing
user gets, so nothing changes for them until a limit is set.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d3f5b81a2c46"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("ip_limit", sa.BigInteger(), nullable=True))
    op.add_column("user_templates", sa.Column("ip_limit", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_templates", "ip_limit")
    op.drop_column("users", "ip_limit")
