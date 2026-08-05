from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.db import AsyncSession, get_db
from app.db.crud.user import get_user
from app.models.admin import AdminDetails
from app.models.proxy import ProxyTable
from app.operation import OperatorType
from app.operation.user import UserOperation
from app.utils import openvpn_pki, responses
from app.utils.openvpn import ensure_openvpn_ca

from .authentication import require_permission

router = APIRouter(tags=["OpenVPN"], prefix="/api/openvpn", responses={401: responses._401, 403: responses._403})

user_operator = UserOperation(operator_type=OperatorType.API)


@router.get("/ca")
async def get_openvpn_ca(
    _: AdminDetails = Depends(require_permission("settings", "read")),
    db: AsyncSession = Depends(get_db),
):
    """Panel-wide OpenVPN CA certificate and its metadata (private key never returned)."""
    ca = await ensure_openvpn_ca(db)
    info = openvpn_pki.cert_info(ca.get("ca_cert")) or {}
    return {
        "ca_cert": ca.get("ca_cert"),
        "tls_crypt_key_present": bool(ca.get("tls_crypt_key")),
        "client_cert_validity_days": ca.get("client_cert_validity_days"),
        **info,
    }


@router.get("/ca/export")
async def export_openvpn_ca(
    _: AdminDetails = Depends(require_permission("settings", "read")),
    db: AsyncSession = Depends(get_db),
):
    """Download the CA certificate as a .crt file."""
    ca = await ensure_openvpn_ca(db)
    return Response(
        content=ca.get("ca_cert") or "",
        media_type="application/x-pem-file",
        headers={"Content-Disposition": "attachment; filename=pasarguard-openvpn-ca.crt"},
    )


@router.get("/user/{username}/cert")
async def get_user_openvpn_cert(
    username: str,
    admin: AdminDetails = Depends(require_permission("users", "read")),
    db: AsyncSession = Depends(get_db),
):
    """The user's OpenVPN client certificate metadata (expiry/serial/fingerprint)."""
    db_user = await get_user(db, username, admin_id=None if admin.is_owner else admin.id)
    if db_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ov = ProxyTable.model_validate(db_user.proxy_settings).openvpn
    info = openvpn_pki.cert_info(ov.cert_pem)
    return {"has_cert": info is not None, **(info or {})}


@router.post("/user/{username}/reissue")
async def reissue_user_openvpn_cert(
    username: str,
    admin: AdminDetails = Depends(require_permission("users", "update")),
    db: AsyncSession = Depends(get_db),
):
    """Re-issue the user's OpenVPN client certificate (new serial) and resync nodes.

    The new serial invalidates the previously distributed .ovpn profile — the node
    denies the old certificate on the next connect.
    """
    db_user = await get_user(db, username, admin_id=None if admin.is_owner else admin.id)
    if db_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    groups = db_user.__dict__.get("groups")
    if groups is None:
        groups = await db_user.awaitable_attrs.groups
    await user_operator._issue_openvpn_cert_if_needed(db, db_user, groups, force_reissue=True)
    await user_operator.update_user(db_user)
    ov = ProxyTable.model_validate(db_user.proxy_settings).openvpn
    info = openvpn_pki.cert_info(ov.cert_pem)
    return {"has_cert": info is not None, **(info or {})}
