"""merge the l2tp core type and inbound usages branches

Revision ID: f1a2b3c4d5e6
Revises: a7c2e94d0b13, c4f8a12d7e90
Create Date: 2026-08-20 16:00:00.000000

feat/l2tp (a7c2e94d0b13, widens the core-type enum) and feat/inbound-usage
(c4f8a12d7e90, adds inbound_usages) both grew out of e1c8a3f0b562, so a tree
containing both has two heads and `alembic upgrade head` refuses to run. This
empty merge point joins them; it belongs in whichever branch merges second.
"""

# revision identifiers, used by Alembic.
revision = "f1a2b3c4d5e6"
down_revision = ("a7c2e94d0b13", "c4f8a12d7e90")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
