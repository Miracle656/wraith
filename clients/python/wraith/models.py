"""Typed dataclasses mirroring the Wraith REST API response shapes.

Each ``from_dict`` classmethod is tolerant of missing/extra keys so the models
keep working as the API gains fields. Numeric amounts are kept as strings to
preserve the full i128 precision the API returns (a 64-bit float would lose it).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _opt_int(value: Any) -> Optional[int]:
    return int(value) if value is not None else None


@dataclass
class Transfer:
    """A single SEP-41/CAP-67 token event (transfer, mint, burn, clawback)."""

    id: Optional[int]
    contract_id: str
    event_type: str
    from_address: Optional[str]
    to_address: Optional[str]
    amount: str
    ledger: int
    ledger_closed_at: str
    tx_hash: str
    event_id: str
    is_sac: bool = False
    display_amount: Optional[str] = None
    direction: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Transfer":
        return cls(
            id=_opt_int(data.get("id")),
            contract_id=data.get("contractId", ""),
            event_type=data.get("eventType", ""),
            from_address=data.get("fromAddress"),
            to_address=data.get("toAddress"),
            amount=str(data.get("amount", "0")),
            ledger=int(data.get("ledger", 0)),
            ledger_closed_at=data.get("ledgerClosedAt", ""),
            tx_hash=data.get("txHash", ""),
            event_id=data.get("eventId", ""),
            is_sac=bool(data.get("isSac", False)),
            display_amount=data.get("displayAmount"),
            direction=data.get("direction"),
            raw=data,
        )


@dataclass
class TransferPage:
    """A page of transfers plus pagination metadata."""

    transfers: List[Transfer]
    total: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None
    next_cursor: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TransferPage":
        return cls(
            transfers=[Transfer.from_dict(t) for t in data.get("transfers", [])],
            total=_opt_int(data.get("total")),
            limit=_opt_int(data.get("limit")),
            offset=_opt_int(data.get("offset")),
            next_cursor=data.get("nextCursor"),
        )


@dataclass
class AssetHolding:
    """One row of an account's per-asset summary."""

    contract_id: str
    total_sent: str
    total_received: str
    net: str
    tx_count: int
    last_activity_at: Optional[str] = None
    display_total_sent: Optional[str] = None
    display_total_received: Optional[str] = None
    display_net: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AssetHolding":
        return cls(
            contract_id=data.get("contractId", ""),
            total_sent=str(data.get("totalSent", "0")),
            total_received=str(data.get("totalReceived", "0")),
            net=str(data.get("net", "0")),
            tx_count=int(data.get("txCount", 0)),
            last_activity_at=data.get("lastActivityAt"),
            display_total_sent=data.get("displayTotalSent"),
            display_total_received=data.get("displayTotalReceived"),
            display_net=data.get("displayNet"),
        )


@dataclass
class AccountSummary:
    """An account's holdings across every asset it has touched."""

    address: str
    assets: List[AssetHolding]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AccountSummary":
        return cls(
            address=data.get("address", ""),
            assets=[AssetHolding.from_dict(a) for a in data.get("assets", [])],
        )


@dataclass
class PopularAsset:
    """An asset ranked in the /assets/popular leaderboard."""

    contract_id: str
    transfer_count: int
    volume: str
    display_volume: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PopularAsset":
        return cls(
            contract_id=data.get("contractId", ""),
            transfer_count=int(data.get("transferCount", 0)),
            volume=str(data.get("volume", "0")),
            display_volume=data.get("displayVolume"),
        )


@dataclass
class PopularAssets:
    """The /assets/popular response: a ranked list plus the query window."""

    window: str
    by: str
    assets: List[PopularAsset]
    total: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PopularAssets":
        return cls(
            window=data.get("window", ""),
            by=data.get("by", ""),
            assets=[PopularAsset.from_dict(a) for a in data.get("assets", [])],
            total=_opt_int(data.get("total")),
            limit=_opt_int(data.get("limit")),
            offset=_opt_int(data.get("offset")),
        )


@dataclass
class Status:
    """Indexer progress, ledger lag, and health reported by ``GET /status``."""

    ok: bool
    last_indexed_ledger: Optional[int]
    latest_ledger: Optional[int]
    lag_ledgers: Optional[int]
    started_at: str = ""
    uptime_seconds: int = 0
    total_indexed: int = 0
    status: Optional[str] = None
    network: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Status":
        ok_val = data.get("ok")
        if ok_val is None and data.get("status") is not None:
            ok_val = data.get("status") == "healthy"
        return cls(
            ok=bool(ok_val),
            last_indexed_ledger=_opt_int(data.get("lastIndexedLedger")),
            latest_ledger=_opt_int(data.get("latestLedger")),
            lag_ledgers=_opt_int(data.get("lagLedgers")),
            started_at=data.get("startedAt", ""),
            uptime_seconds=int(data.get("uptimeSeconds", 0) or 0),
            total_indexed=int(data.get("totalIndexed", 0) or 0),
            status=data.get("status"),
            network=data.get("network"),
            raw=data,
        )


@dataclass
class NftTransfer:
    """A single NFT (token-id) transfer event."""

    id: Optional[int]
    contract_id: str
    token_id: str
    from_address: Optional[str]
    to_address: Optional[str]
    ledger: int
    ledger_closed_at: str
    tx_hash: str
    event_id: str
    created_at: str = ""
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "NftTransfer":
        token_val = data.get("tokenId")
        return cls(
            id=_opt_int(data.get("id")),
            contract_id=data.get("contractId", ""),
            token_id=str(token_val) if token_val is not None else "",
            from_address=data.get("fromAddress"),
            to_address=data.get("toAddress"),
            ledger=int(data.get("ledger", 0)),
            ledger_closed_at=data.get("ledgerClosedAt", ""),
            tx_hash=data.get("txHash", ""),
            event_id=data.get("eventId", ""),
            created_at=data.get("createdAt", ""),
            raw=data,
        )


NFTTransfer = NftTransfer


@dataclass
class NftTransferPage:
    """A page of NFT transfers plus pagination metadata."""

    transfers: List[NftTransfer]
    total: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None
    next_cursor: Optional[str] = None
    has_more: Optional[bool] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "NftTransferPage":
        has_more_val = data.get("hasMore")
        return cls(
            transfers=[NftTransfer.from_dict(t) for t in data.get("transfers", [])],
            total=_opt_int(data.get("total")),
            limit=_opt_int(data.get("limit")),
            offset=_opt_int(data.get("offset")),
            next_cursor=data.get("nextCursor"),
            has_more=bool(has_more_val) if has_more_val is not None else None,
        )


NFTTransferPage = NftTransferPage


@dataclass
class NftMetadata:
    """Resolved token_uri metadata attached to an NFT owner response."""

    token_uri: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
    fetched_at: Optional[str] = None
    fetch_error: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "NftMetadata":
        return cls(
            token_uri=data.get("tokenUri"),
            name=data.get("name"),
            description=data.get("description"),
            image=data.get("image"),
            raw=data.get("raw"),
            fetched_at=data.get("fetchedAt"),
            fetch_error=data.get("fetchError"),
        )


NFTMetadata = NftMetadata


@dataclass
class NftOwner:
    """Current owner of a specific NFT ``(contract, token_id)`` pair."""

    contract_id: str
    token_id: str
    owner: Optional[str]
    burned: bool = False
    last_tx_hash: str = ""
    last_ledger: int = 0
    last_updated_at: str = ""
    metadata: Optional[NftMetadata] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "NftOwner":
        token_val = data.get("tokenId")
        meta = data.get("metadata")
        return cls(
            contract_id=data.get("contractId", ""),
            token_id=str(token_val) if token_val is not None else "",
            owner=data.get("owner"),
            burned=bool(data.get("burned", False)),
            last_tx_hash=data.get("lastTxHash", ""),
            last_ledger=int(data.get("lastLedger", 0) or 0),
            last_updated_at=data.get("lastUpdatedAt", ""),
            metadata=NftMetadata.from_dict(meta) if isinstance(meta, dict) else None,
            raw=data,
        )


NFTOwner = NftOwner


@dataclass
class WebhookSubscription:
    """A registered webhook subscription."""

    id: int
    url: str
    filter: Optional[Any] = None
    active: bool = True
    created_at: str = ""
    updated_at: Optional[str] = None
    secret: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WebhookSubscription":
        return cls(
            id=int(data.get("id", 0)),
            url=data.get("url", ""),
            filter=data.get("filter"),
            active=bool(data.get("active", True)),
            created_at=data.get("createdAt", ""),
            updated_at=data.get("updatedAt"),
            secret=data.get("secret"),
            raw=data,
        )


@dataclass
class WebhookSubscriptionList:
    """The ``GET /webhooks`` response containing registered subscriptions."""

    subscriptions: List[WebhookSubscription]

    def __iter__(self):
        return iter(self.subscriptions)

    def __len__(self) -> int:
        return len(self.subscriptions)

    def __getitem__(self, index: int) -> WebhookSubscription:
        return self.subscriptions[index]

    @classmethod
    def from_dict(cls, data: Any) -> "WebhookSubscriptionList":
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            items = data.get("subscriptions", data.get("webhooks", []))
        else:
            items = []
        return cls(
            subscriptions=[WebhookSubscription.from_dict(s) for s in items],
        )


@dataclass
class WebhookDelivery:
    """A single webhook delivery attempt record."""

    id: int
    event_id: str
    status: str
    attempts: int
    last_status_code: Optional[int] = None
    last_error: Optional[str] = None
    next_retry_at: Optional[str] = None
    delivered_at: Optional[str] = None
    created_at: str = ""
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WebhookDelivery":
        return cls(
            id=int(data.get("id", 0)),
            event_id=str(data.get("eventId", "")),
            status=data.get("status", ""),
            attempts=int(data.get("attempts", 0)),
            last_status_code=_opt_int(data.get("lastStatusCode")),
            last_error=data.get("lastError"),
            next_retry_at=data.get("nextRetryAt"),
            delivered_at=data.get("deliveredAt"),
            created_at=data.get("createdAt", ""),
            raw=data,
        )


@dataclass
class WebhookDeliveryList:
    """The ``GET /webhooks/:id/deliveries`` response."""

    deliveries: List[WebhookDelivery]
    total: Optional[int] = None
    limit: Optional[int] = None
    offset: Optional[int] = None

    def __iter__(self):
        return iter(self.deliveries)

    def __len__(self) -> int:
        return len(self.deliveries)

    def __getitem__(self, index: int) -> WebhookDelivery:
        return self.deliveries[index]

    @classmethod
    def from_dict(cls, data: Any) -> "WebhookDeliveryList":
        if isinstance(data, list):
            return cls(
                deliveries=[WebhookDelivery.from_dict(d) for d in data],
                total=len(data),
            )
        items = data.get("deliveries", []) if isinstance(data, dict) else []
        return cls(
            deliveries=[WebhookDelivery.from_dict(d) for d in items],
            total=_opt_int(data.get("total")) if isinstance(data, dict) else None,
            limit=_opt_int(data.get("limit")) if isinstance(data, dict) else None,
            offset=_opt_int(data.get("offset")) if isinstance(data, dict) else None,
        )


WebhookDeliveryPage = WebhookDeliveryList
