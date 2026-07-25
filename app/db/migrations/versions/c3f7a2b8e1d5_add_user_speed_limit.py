"""add per-user speed limit

Revision ID: c3f7a2b8e1d5
Revises: d3f5b81a2c46
Create Date: 2026-08-28 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3f7a2b8e1d5"
down_revision = "d3f5b81a2c46"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("speed_limit", sa.BigInteger(), nullable=True))
    op.add_column("user_templates", sa.Column("speed_limit", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_templates", "speed_limit")
    op.drop_column("users", "speed_limit")
