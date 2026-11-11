"""Tests for the Wraith Python client.

HTTP is stubbed with the ``responses`` library so the tests run offline and
assert both request shaping (query params) and response parsing.
"""

import json

import pytest
import responses

from wraith import WraithAPIError, WraithClient

BASE = "https://wraith.test"


@pytest.fixture
def client():
    with WraithClient(BASE) as c:
        yield c


@responses.activate
def test_incoming_transfers_parses_and_tags_sac(client):
    responses.add(
        responses.GET,
        f"{BASE}/transfers/incoming/GABC",
        json={
            "total": 1,
            "limit": 50,
            "offset": 0,
            "nextCursor": None,
            "transfers": [
                {
                    "id": 1,
                    "contractId": "CSAC",
                    "eventType": "transfer",
                    "fromAddress": "GFROM",
                    "toAddress": "GABC",
                    "amount": "10000000",
                    "ledger": 100,
                    "ledgerClosedAt": "2026-01-01T00:00:00Z",
                    "txHash": "deadbeef",
                    "eventId": "evt-1",
                    "isSac": True,
                    "displayAmount": "1.0000000",
                }
            ],
        },
        status=200,
    )

    page = client.incoming_transfers("GABC", limit=50)

    assert page.total == 1
    assert len(page.transfers) == 1
    transfer = page.transfers[0]
    assert transfer.contract_id == "CSAC"
    assert transfer.is_sac is True
    assert transfer.amount == "10000000"
    assert transfer.display_amount == "1.0000000"


@responses.activate
def test_query_params_drop_none_and_pass_through(client):
    responses.add(
        responses.GET,
        f"{BASE}/transfers/address/GABC",
        json={"transfers": []},
        status=200,
    )

    client.address_transfers("GABC", contract_id="CXYZ", limit=10)

    request = responses.calls[0].request
    assert "contractId=CXYZ" in request.url
    assert "limit=10" in request.url
    # None-valued params (token, cursor, …) must not be serialised.
    assert "token=" not in request.url
    assert "cursor=" not in request.url


@responses.activate
def test_account_summary(client):
    responses.add(
        responses.GET,
        f"{BASE}/accounts/GABC/summary",
        json={
            "address": "GABC",
            "assets": [
                {
                    "contractId": "CXLM",
                    "totalSent": "5",
                    "totalReceived": "12",
                    "net": "7",
                    "txCount": 3,
                    "lastActivityAt": "2026-01-01T00:00:00Z",
                }
            ],
        },
        status=200,
    )

    summary = client.account_summary("GABC")

    assert summary.address == "GABC"
    assert len(summary.assets) == 1
    assert summary.assets[0].contract_id == "CXLM"
    assert summary.assets[0].tx_count == 3
    assert summary.assets[0].net == "7"


@responses.activate
def test_popular_assets(client):
    responses.add(
        responses.GET,
        f"{BASE}/assets/popular",
        json={
            "window": "24h",
            "by": "volume",
            "total": 1,
            "assets": [
                {
                    "contractId": "CXLM",
                    "transferCount": 42,
                    "volume": "1000",
                    "displayVolume": "0.0001000",
                }
            ],
        },
        status=200,
    )

    result = client.popular_assets(window="24h", by="volume")

    assert result.by == "volume"
    assert result.assets[0].transfer_count == 42
    assert result.assets[0].volume == "1000"


@responses.activate
def test_transaction_transfers(client):
    responses.add(
        responses.GET,
        f"{BASE}/transfers/tx/abc123",
        json={"transfers": [{"contractId": "C1", "eventType": "mint", "amount": "5"}]},
        status=200,
    )

    transfers = client.transaction_transfers("abc123")

    assert len(transfers) == 1
    assert transfers[0].event_type == "mint"


@responses.activate
def test_status_parses_indexer_progress(client):
    responses.add(
        responses.GET,
        f"{BASE}/status",
        json={
            "ok": True,
            "lastIndexedLedger": 543210,
            "latestLedger": 543212,
            "lagLedgers": 2,
            "startedAt": "2026-01-01T00:00:00Z",
            "uptimeSeconds": 3600,
            "totalIndexed": 98765,
            "status": "healthy",
            "network": "testnet",
        },
        status=200,
    )

    st = client.status()

    assert st.ok is True
    assert st.last_indexed_ledger == 543210
    assert st.latest_ledger == 543212
    assert st.lag_ledgers == 2
    assert st.started_at == "2026-01-01T00:00:00Z"
    assert st.uptime_seconds == 3600
    assert st.total_indexed == 98765
    assert st.status == "healthy"
    assert st.network == "testnet"


@responses.activate
def test_nft_transfers_filters_and_parses(client):
    responses.add(
        responses.GET,
        f"{BASE}/nfts/transfers",
        json={
            "total": 1,
            "limit": 20,
            "offset": 0,
            "nextCursor": "500:7",
            "hasMore": True,
            "transfers": [
                {
                    "id": 7,
                    "contractId": "CNFT",
                    "tokenId": "42",
                    "fromAddress": "GFROM",
                    "toAddress": "GTO",
                    "ledger": 500,
                    "ledgerClosedAt": "2026-01-02T00:00:00Z",
                    "txHash": "cafebabe",
                    "eventId": "evt-nft-7",
                    "createdAt": "2026-01-02T00:00:01Z",
                }
            ],
        },
        status=200,
    )

    page = client.nft_transfers(
        contract="CNFT",
        token_id="42",
        address="GTO",
        from_ledger=100,
        to_ledger=600,
        limit=20,
    )

    request = responses.calls[0].request
    assert "contract=CNFT" in request.url
    assert "token_id=42" in request.url
    assert "address=GTO" in request.url
    assert "fromLedger=100" in request.url
    assert "toLedger=600" in request.url
    assert "limit=20" in request.url
    assert "cursor=" not in request.url

    assert page.total == 1
    assert page.next_cursor == "500:7"
    assert page.has_more is True
    assert len(page.transfers) == 1
    tx = page.transfers[0]
    assert tx.id == 7
    assert tx.contract_id == "CNFT"
    assert tx.token_id == "42"
    assert tx.from_address == "GFROM"
    assert tx.to_address == "GTO"
    assert tx.ledger == 500
    assert tx.tx_hash == "cafebabe"
    assert tx.event_id == "evt-nft-7"


@responses.activate
def test_nft_owner_parses_metadata(client):
    responses.add(
        responses.GET,
        f"{BASE}/nfts/owners/CNFT/42",
        json={
            "contractId": "CNFT",
            "tokenId": "42",
            "owner": "GOWNER",
            "burned": False,
            "lastTxHash": "cafebabe",
            "lastLedger": 500,
            "lastUpdatedAt": "2026-01-02T00:00:00Z",
            "metadata": {
                "tokenUri": "ipfs://cid/42.json",
                "name": "Wraith #42",
                "description": "Forty-two",
                "image": "ipfs://cid/42.png",
            },
        },
        status=200,
    )

    owner = client.nft_owner("CNFT", "42")

    assert owner.contract_id == "CNFT"
    assert owner.token_id == "42"
    assert owner.owner == "GOWNER"
    assert owner.burned is False
    assert owner.last_ledger == 500
    assert owner.metadata is not None
    assert owner.metadata.name == "Wraith #42"
    assert owner.metadata.token_uri == "ipfs://cid/42.json"


@responses.activate
def test_webhooks_list_and_deliveries(client):
    responses.add(
        responses.GET,
        f"{BASE}/webhooks",
        json={
            "subscriptions": [
                {
                    "id": 11,
                    "url": "https://hooks.example.com/wraith",
                    "filter": '{"contractId":"CSAC"}',
                    "active": True,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T01:00:00Z",
                }
            ]
        },
        status=200,
    )
    responses.add(
        responses.GET,
        f"{BASE}/webhooks/11/deliveries",
        json={
            "total": 1,
            "limit": 10,
            "offset": 0,
            "deliveries": [
                {
                    "id": 99,
                    "eventId": "evt-1",
                    "status": "delivered",
                    "attempts": 1,
                    "lastStatusCode": 200,
                    "lastError": None,
                    "nextRetryAt": None,
                    "deliveredAt": "2026-01-01T00:00:02Z",
                    "createdAt": "2026-01-01T00:00:01Z",
                }
            ],
        },
        status=200,
    )

    subs = client.webhooks()
    assert len(subs) == 1
    assert subs.subscriptions[0].id == 11
    assert subs[0].url == "https://hooks.example.com/wraith"
    assert subs[0].active is True

    deliveries = client.webhook_deliveries(11, status="delivered", limit=10)
    req = responses.calls[1].request
    assert "status=delivered" in req.url
    assert "limit=10" in req.url
    assert "offset=" not in req.url

    assert deliveries.total == 1
    assert len(deliveries) == 1
    d = deliveries.deliveries[0]
    assert d.id == 99
    assert d.event_id == "evt-1"
    assert d.status == "delivered"
    assert d.attempts == 1
    assert d.last_status_code == 200


@responses.activate
def test_create_and_delete_webhook(client):
    responses.add(
        responses.POST,
        f"{BASE}/webhooks",
        json={
            "id": 12,
            "url": "https://hooks.example.com/new",
            "secret": "whsec_123",
            "filter": {"contractId": "CSAC"},
            "active": True,
            "createdAt": "2026-01-03T00:00:00Z",
        },
        status=201,
    )
    responses.add(
        responses.DELETE,
        f"{BASE}/webhooks/12",
        status=204,
    )

    created = client.create_webhook(
        "https://hooks.example.com/new",
        secret="whsec_123",
        filter={"contractId": "CSAC"},
    )
    post_body = json.loads(responses.calls[0].request.body)
    assert post_body == {
        "url": "https://hooks.example.com/new",
        "secret": "whsec_123",
        "filter": {"contractId": "CSAC"},
    }
    assert created.id == 12
    assert created.secret == "whsec_123"

    client.delete_webhook(12)
    assert responses.calls[1].request.method == "DELETE"


@responses.activate
def test_api_error_raises(client):
    responses.add(
        responses.GET,
        f"{BASE}/transfers/incoming/GBAD",
        json={"error": "boom"},
        status=500,
    )

    with pytest.raises(WraithAPIError) as exc:
        client.incoming_transfers("GBAD")

    assert exc.value.status_code == 500
    assert "boom" in str(exc.value)


def test_base_url_required():
    with pytest.raises(ValueError):
        WraithClient("")
