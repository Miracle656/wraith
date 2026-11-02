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
    NFTMetadata,
    NFTOwner,
    NFTTransfer,
    NFTTransferPage,
    NftMetadata,
    NftOwner,
    NftTransfer,
    NftTransferPage,
    PopularAsset,
    PopularAssets,
    Status,
    Transfer,
    TransferPage,
    WebhookDelivery,
    WebhookDeliveryList,
    WebhookDeliveryPage,
    WebhookSubscription,
    WebhookSubscriptionList,
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
    "Status",
    "NftTransfer",
    "NFTTransfer",
    "NftTransferPage",
    "NFTTransferPage",
    "NftMetadata",
    "NFTMetadata",
    "NftOwner",
    "NFTOwner",
    "WebhookSubscription",
    "WebhookSubscriptionList",
    "WebhookDelivery",
    "WebhookDeliveryList",
    "WebhookDeliveryPage",
    "__version__",
]
