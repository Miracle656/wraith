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
