"""add user ip_limit

Revision ID: b3e8c2f4a1d7
Revises: a7f3c1e9d0b2
Create Date: 2026-07-13 03:40:00.000000

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "b3e8c2f4a1d7"
down_revision = "a7f3c1e9d0b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("ip_limit", sa.BigInteger(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("users", "ip_limit")
