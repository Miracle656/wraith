# wraith-py

Python client for the [Wraith](https://github.com/Miracle656/wraith) Soroban
token transfer indexer REST API. Wraps the REST endpoints in typed dataclasses
so data analysts get autocompletion and full i128 precision (amounts are kept as
strings).

## Install

```bash
pip install wraith-py
```

## Usage

```python
from wraith import WraithClient

client = WraithClient("https://wraith.example.com")

# Transfers received by an address
page = client.incoming_transfers("GABC...", limit=100)
for transfer in page.transfers:
    # is_sac distinguishes SAC-wrapped classic assets from native Soroban tokens
    print(transfer.contract_id, transfer.amount, transfer.is_sac)

# Paginate with the cursor
if page.next_cursor:
    more = client.incoming_transfers("GABC...", cursor=page.next_cursor)

# Per-asset holdings for an account
summary = client.account_summary("GABC...")
for holding in summary.assets:
    print(holding.contract_id, holding.net, holding.tx_count)

# Most-active assets
popular = client.popular_assets(window="24h", by="volume")
for asset in popular.assets:
    print(asset.contract_id, asset.transfer_count, asset.volume)

client.close()  # or use the client as a context manager
```

## Coverage

| Area      | Methods                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| Transfers | `incoming_transfers`, `outgoing_transfers`, `address_transfers`, `transaction_transfers` |
| Accounts  | `account_summary`, `account_transfers`                                                  |
| Assets    | `popular_assets`                                                                        |

All responses are returned as typed dataclasses (`Transfer`, `TransferPage`,
`AccountSummary`, `AssetHolding`, `PopularAssets`, `PopularAsset`). Non-2xx
responses raise `WraithAPIError`.

## Development

```bash
pip install -e ".[dev]"
pytest
```

## Publishing

Builds are published to PyPI from CI on tags matching `pyclient-v*` (see
`.github/workflows/publish-python-sdk.yml`). To publish manually:

```bash
python -m build
twine upload dist/*
```
