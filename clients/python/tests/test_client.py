"""Tests for the Wraith Python client.

HTTP is stubbed with the ``responses`` library so the tests run offline and
assert both request shaping (query params) and response parsing.
"""

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
