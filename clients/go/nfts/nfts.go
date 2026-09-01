// Package nfts is the Wraith client for NFT (token-id) endpoints.
package nfts

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /nfts endpoints.
type Client struct {
	c *wraith.Client
}

// New returns an nfts client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Transfer is a single NFT transfer event.
type Transfer struct {
	ID             int64   `json:"id"`
	ContractID     string  `json:"contractId"`
	TokenID        string  `json:"tokenId"`
	FromAddress    *string `json:"fromAddress"`
	ToAddress      *string `json:"toAddress"`
	Ledger         int64   `json:"ledger"`
	LedgerClosedAt string  `json:"ledgerClosedAt"`
	TxHash         string  `json:"txHash"`
	EventID        string  `json:"eventId"`
	CreatedAt      string  `json:"createdAt"`
}

// Page is a page of NFT transfers plus pagination metadata.
type Page struct {
	Transfers  []Transfer `json:"transfers"`
	Total      int        `json:"total"`
	Limit      int        `json:"limit"`
	Offset     int        `json:"offset"`
	NextCursor *string    `json:"nextCursor"`
}

// TransfersParams are the optional filters for Transfers.
type TransfersParams struct {
	Contract   string
	TokenID    string
	Address    string
	FromLedger *int
	ToLedger   *int
	Limit      *int
	Offset     *int
	Cursor     string
}

func (p *TransfersParams) query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	wraith.AddString(q, "contract", p.Contract)
	wraith.AddString(q, "token_id", p.TokenID)
	wraith.AddString(q, "address", p.Address)
	wraith.AddInt(q, "fromLedger", p.FromLedger)
	wraith.AddInt(q, "toLedger", p.ToLedger)
	wraith.AddInt(q, "limit", p.Limit)
	wraith.AddInt(q, "offset", p.Offset)
	wraith.AddString(q, "cursor", p.Cursor)
	return q
}

// Transfers returns NFT transfers (GET /nfts/transfers).
func (n *Client) Transfers(ctx context.Context, params *TransfersParams) (*Page, error) {
	var page Page
	if err := n.c.Get(ctx, "/nfts/transfers", params.query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}
