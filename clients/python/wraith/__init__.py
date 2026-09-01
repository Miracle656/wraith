"""wraith-py — Python client for the Wraith Soroban token transfer indexer.

Quickstart:
    from wraith import WraithClient

    client = WraithClient("https://wraith.example.com")
    page = client.incoming_transfers("GABC...")
    for transfer in page.transfers:
        print(transfer.contract_id, transfer.amount, transfer.is_sac)
"""

from .client import WraithClient
from .errors import WraithAPIError, WraithError
from .models import (
    AccountSummary,
    AssetHolding,
    PopularAsset,
    PopularAssets,
    Transfer,
    TransferPage,
)

__version__ = "0.1.0"

__all__ = [
    "WraithClient",
    "WraithError",
    "WraithAPIError",
    "Transfer",
    "TransferPage",
    "AccountSummary",
    "AssetHolding",
    "PopularAsset",
    "PopularAssets",
    "__version__",
]
