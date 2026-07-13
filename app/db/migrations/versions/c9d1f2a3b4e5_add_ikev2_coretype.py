"""add ikev2 coretype enum value

IKEv2/IPsec reuses the panel-wide OpenVPN CA for its server certificate and
stores per-user EAP credentials inside ``proxy_settings`` (handled by the
Pydantic model default), so only the ``coretype`` enum needs a new value on
PostgreSQL. On SQLite/MySQL the column is a plain string — no-op.

Revision ID: c9d1f2a3b4e5
Revises: b3e8c2f4a1d7
"""

from alembic import op

revision = "c9d1f2a3b4e5"
down_revision = "b3e8c2f4a1d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.engine.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE coretype ADD VALUE IF NOT EXISTS 'ikev2'")


def downgrade() -> None:
    # Removing a postgres enum value requires recreating the type; left in place.
    pass
