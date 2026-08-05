"""add openvpn core type

Revision ID: b8e4c07d19a3
Revises: a7f3d21c9e84
Create Date: 2026-08-05 00:00:00.000000

SQLite and MySQL store this column as a string and need nothing done, but
PostgreSQL enforces a real enum type, so "openvpn" has to be added as a value
before a core of that type can be saved.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "b8e4c07d19a3"
down_revision = "a7f3d21c9e84"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().engine.name != "postgresql":
        return
    # IF NOT EXISTS keeps this idempotent, which matters because a database
    # created from the current models already has the value.
    op.execute("ALTER TYPE coretype ADD VALUE IF NOT EXISTS 'openvpn'")


def downgrade() -> None:
    # PostgreSQL cannot drop a value from an enum type. Removing it would mean
    # rebuilding the type and rewriting every column that uses it, which would
    # destroy any core already stored as 'openvpn' — so this is left in place.
    pass
