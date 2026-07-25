"""add user speed_limit

Revision ID: c3f7a2b8e1d5
Revises: a1e6b8c4d9f2
Create Date: 2026-07-25 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c3f7a2b8e1d5"
down_revision = "a1e6b8c4d9f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("speed_limit", sa.BigInteger(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("users", "speed_limit")
