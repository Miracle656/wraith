"""Synchronous client for the Wraith REST API."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import requests

from .errors import WraithAPIError
from .models import (
    AccountSummary,
    NftOwner,
    NftTransferPage,
    PopularAssets,
    Status,
    Transfer,
    TransferPage,
    WebhookDeliveryList,
    WebhookSubscription,
    WebhookSubscriptionList,
)

DEFAULT_TIMEOUT = 30


class WraithClient:
    """A thin, typed wrapper over the Wraith REST API.

    Example:
        >>> client = WraithClient("https://wraith.example.com")
        >>> page = client.incoming_transfers("GABC...")
        >>> for transfer in page.transfers:
        ...     print(transfer.contract_id, transfer.amount, transfer.is_sac)
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        session: Optional[requests.Session] = None,
    ):
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()

    # ── Internal helpers ────────────────────────────────────────────────────
    @staticmethod
    def _raise_for_error(resp: requests.Response) -> None:
        if resp.ok:
            return
        message = None
        try:
            body = resp.json()
            if isinstance(body, dict):
                message = body.get("error") or body.get("message")
        except ValueError:
            message = resp.text or None
        raise WraithAPIError(resp.status_code, message)

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        resp = self._session.get(
            f"{self.base_url}{path}", params=clean, timeout=self.timeout
        )
        self._raise_for_error(resp)
        return resp.json()

    def _post(self, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        clean = {k: v for k, v in (payload or {}).items() if v is not None}
        resp = self._session.post(
            f"{self.base_url}{path}", json=clean, timeout=self.timeout
        )
        self._raise_for_error(resp)
        if not resp.content:
            return {}
        return resp.json()

    def _delete(self, path: str) -> None:
        resp = self._session.delete(
            f"{self.base_url}{path}", timeout=self.timeout
        )
        self._raise_for_error(resp)

    @staticmethod
    def _transfer_params(
        contract_id: Optional[str],
        token: Optional[str],
        event_type: Optional[str],
        from_ledger: Optional[int],
        to_ledger: Optional[int],
        from_date: Optional[str],
        to_date: Optional[str],
        limit: Optional[int],
        offset: Optional[int],
        cursor: Optional[str],
    ) -> Dict[str, Any]:
        return {
            "contractId": contract_id,
            "token": token,
            "eventType": event_type,
            "fromLedger": from_ledger,
            "toLedger": to_ledger,
            "fromDate": from_date,
            "toDate": to_date,
            "limit": limit,
            "offset": offset,
            "cursor": cursor,
        }

    # ── Transfers ───────────────────────────────────────────────────────────
    def incoming_transfers(
        self,
        address: str,
        *,
        contract_id: Optional[str] = None,
        token: Optional[str] = None,
        event_type: Optional[str] = None,
        from_ledger: Optional[int] = None,
        to_ledger: Optional[int] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TransferPage:
        """Transfers received by ``address`` (``GET /transfers/incoming/:address``)."""
        data = self._get(
            f"/transfers/incoming/{address}",
            self._transfer_params(
                contract_id, token, event_type, from_ledger, to_ledger,
                from_date, to_date, limit, offset, cursor,
            ),
        )
        return TransferPage.from_dict(data)

    def outgoing_transfers(
        self,
        address: str,
        *,
        contract_id: Optional[str] = None,
        token: Optional[str] = None,
        event_type: Optional[str] = None,
        from_ledger: Optional[int] = None,
        to_ledger: Optional[int] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TransferPage:
        """Transfers sent by ``address`` (``GET /transfers/outgoing/:address``)."""
        data = self._get(
            f"/transfers/outgoing/{address}",
            self._transfer_params(
                contract_id, token, event_type, from_ledger, to_ledger,
                from_date, to_date, limit, offset, cursor,
            ),
        )
        return TransferPage.from_dict(data)

    def address_transfers(
        self,
        address: str,
        *,
        contract_id: Optional[str] = None,
        token: Optional[str] = None,
        event_type: Optional[str] = None,
        from_ledger: Optional[int] = None,
        to_ledger: Optional[int] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TransferPage:
        """Transfers sent or received by ``address``, each tagged with a direction
        (``GET /transfers/address/:address``)."""
        data = self._get(
            f"/transfers/address/{address}",
            self._transfer_params(
                contract_id, token, event_type, from_ledger, to_ledger,
                from_date, to_date, limit, offset, cursor,
            ),
        )
        return TransferPage.from_dict(data)

    def transaction_transfers(self, tx_hash: str) -> List[Transfer]:
        """All token events emitted within a transaction
        (``GET /transfers/tx/:txHash``)."""
        data = self._get(f"/transfers/tx/{tx_hash}")
        return [Transfer.from_dict(t) for t in data.get("transfers", [])]

    # ── Accounts ────────────────────────────────────────────────────────────
    def account_summary(
        self, address: str, *, contract_id: Optional[str] = None
    ) -> AccountSummary:
        """Per-asset holdings for ``address``
        (``GET /accounts/:address/summary``)."""
        data = self._get(
            f"/accounts/{address}/summary", {"contractId": contract_id}
        )
        return AccountSummary.from_dict(data)

    def account_transfers(
        self,
        address: str,
        *,
        contract_id: Optional[str] = None,
        token: Optional[str] = None,
        event_type: Optional[str] = None,
        from_ledger: Optional[int] = None,
        to_ledger: Optional[int] = None,
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TransferPage:
        """Transfers for ``address`` via the accounts router
        (``GET /accounts/:address/transfers``)."""
        data = self._get(
            f"/accounts/{address}/transfers",
            self._transfer_params(
                contract_id, token, event_type, from_ledger, to_ledger,
                from_date, to_date, limit, offset, cursor,
            ),
        )
        return TransferPage.from_dict(data)

    # ── Assets ──────────────────────────────────────────────────────────────
    def popular_assets(
        self,
        *,
        window: str = "24h",
        by: str = "transfers",
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> PopularAssets:
        """The most-active assets in a time window
        (``GET /assets/popular``)."""
        data = self._get(
            "/assets/popular",
            {"window": window, "by": by, "limit": limit, "offset": offset},
        )
        return PopularAssets.from_dict(data)

    # ── Status ──────────────────────────────────────────────────────────────
    def status(self) -> Status:
        """Current indexer progress, lag, and health (``GET /status``)."""
        data = self._get("/status")
        return Status.from_dict(data)

    # ── NFTs ────────────────────────────────────────────────────────────────
    def nft_transfers(
        self,
        *,
        contract: Optional[str] = None,
        token_id: Optional[str] = None,
        address: Optional[str] = None,
        from_ledger: Optional[int] = None,
        to_ledger: Optional[int] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> NftTransferPage:
        """NFT (token-id) transfer events (``GET /nfts/transfers``)."""
        data = self._get(
            "/nfts/transfers",
            {
                "contract": contract,
                "token_id": token_id,
                "address": address,
                "fromLedger": from_ledger,
                "toLedger": to_ledger,
                "limit": limit,
                "offset": offset,
                "cursor": cursor,
            },
        )
        return NftTransferPage.from_dict(data)

    def nft_owner(self, contract: str, token_id: str) -> NftOwner:
        """Current owner of a specific NFT ``(contract, token_id)`` pair
        (``GET /nfts/owners/:contract/:token_id``)."""
        data = self._get(f"/nfts/owners/{contract}/{token_id}")
        return NftOwner.from_dict(data)

    # ── Webhooks ────────────────────────────────────────────────────────────
    def webhooks(self) -> WebhookSubscriptionList:
        """List all registered webhook subscriptions (``GET /webhooks``)."""
        data = self._get("/webhooks")
        return WebhookSubscriptionList.from_dict(data)

    def webhook_deliveries(
        self,
        webhook_id: int,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> WebhookDeliveryList:
        """Delivery log for a webhook subscription
        (``GET /webhooks/:id/deliveries``)."""
        data = self._get(
            f"/webhooks/{webhook_id}/deliveries",
            {"status": status, "limit": limit, "offset": offset},
        )
        return WebhookDeliveryList.from_dict(data)

    def create_webhook(
        self,
        url: str,
        *,
        secret: Optional[str] = None,
        filter: Optional[Dict[str, Any]] = None,
    ) -> WebhookSubscription:
        """Register a new webhook subscription (``POST /webhooks``)."""
        data = self._post(
            "/webhooks",
            {"url": url, "secret": secret, "filter": filter},
        )
        return WebhookSubscription.from_dict(data)

    def delete_webhook(self, webhook_id: int) -> None:
        """Delete a webhook subscription (``DELETE /webhooks/:id``)."""
        self._delete(f"/webhooks/{webhook_id}")

    # ── Lifecycle ───────────────────────────────────────────────────────────
    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "WraithClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()
