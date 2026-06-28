"""Synchronous client for the Wraith REST API."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import requests

from .errors import WraithAPIError
from .models import AccountSummary, PopularAssets, Transfer, TransferPage

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
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        resp = self._session.get(
            f"{self.base_url}{path}", params=clean, timeout=self.timeout
        )
        if not resp.ok:
            message = None
            try:
                message = resp.json().get("error")
            except ValueError:
                message = resp.text or None
            raise WraithAPIError(resp.status_code, message)
        return resp.json()

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

    # ── Lifecycle ───────────────────────────────────────────────────────────
    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "WraithClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()
