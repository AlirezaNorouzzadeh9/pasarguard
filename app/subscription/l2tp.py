from app.models.subscription import SubscriptionInboundData

from .base import BaseSubscription


class L2TPConfiguration(BaseSubscription):
    """Builds the inline L2TP/IPsec connection details shown on the sub page.

    Like :class:`IKEv2Configuration` this is driven by ``process_inbounds_and_tags``,
    which calls :meth:`add` for every host. Non-L2TP inbounds carry no ``l2tp_psk``
    and are skipped, so only L2TP hosts contribute. User credentials reuse the
    IKEv2 proxy (see the ``l2tp`` fallback in ``process_host``).
    """

    def __init__(self):
        self.proxy_remarks: list[str] = []
        self.details: list[dict[str, str]] = []

    def add(self, remark: str, address: str, inbound: SubscriptionInboundData, settings: dict):
        username = (settings or {}).get("username")
        password = (settings or {}).get("password")
        psk = inbound.l2tp_psk
        if not username or not password or not psk:
            return

        validated_remark = self._remark_validation(remark)
        self.proxy_remarks.append(validated_remark)

        host_addr = (address or "").strip()
        server = host_addr or inbound.l2tp_server_addr
        self.details.append(
            {
                "remark": validated_remark,
                "server": server,
                "username": str(username),
                "password": str(password),
                # "secret" is what L2TP clients (iOS/Android/Windows) call the PSK.
                "secret": str(psk),
            }
        )

    def render(self) -> bytes:
        # The sub page renders `details` inline; there is no separate bundle file.
        return b""
