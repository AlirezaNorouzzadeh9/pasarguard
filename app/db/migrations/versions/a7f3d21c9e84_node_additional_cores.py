"""node additional cores

Revision ID: a7f3d21c9e84
Revises: fb32155473c1
Create Date: 2026-08-05 00:00:00.000000

A node can serve more than one core at a time — several protocols, and also
several cores of the same protocol, such as two WireGuard interfaces with
different exit subnets. A single core_config_id cannot express that, so the
extra cores are kept as a list of ids alongside it.

Nullable with no default: an existing node keeps exactly the behaviour it has
now (one core, from core_config_id) until extra cores are assigned.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = "a7f3d21c9e84"
down_revision = "fb32155473c1"
branch_labels = None
depends_on = None

# JSON everywhere, JSONB on PostgreSQL — matching PostgresJSONB in app/db/models.py
# so the column type is identical to what the ORM expects on every backend.
_JSON_TYPE = sa.JSON().with_variant(JSONB(none_as_null=True), "postgresql")


def upgrade() -> None:
    op.add_column(
        "nodes",
        sa.Column("additional_core_config_ids", _JSON_TYPE, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("nodes", "additional_core_config_ids")
