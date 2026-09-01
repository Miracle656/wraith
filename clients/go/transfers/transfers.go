// Package transfers is the Wraith client for token-transfer endpoints.
package transfers

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /transfers endpoints.
type Client struct {
	c *wraith.Client
}

// New returns a transfers client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Transfer is a single SEP-41/CAP-67 token event (transfer, mint, burn,
// clawback). Amounts are kept as strings to preserve full i128 precision.
type Transfer struct {
	ID             int64   `json:"id"`
	ContractID     string  `json:"contractId"`
	EventType      string  `json:"eventType"`
	FromAddress    *string `json:"fromAddress"`
	ToAddress      *string `json:"toAddress"`
	Amount         string  `json:"amount"`
	DisplayAmount  string  `json:"displayAmount"`
	Ledger         int64   `json:"ledger"`
	LedgerClosedAt string  `json:"ledgerClosedAt"`
	TxHash         string  `json:"txHash"`
	EventID        string  `json:"eventId"`
	Direction      string  `json:"direction,omitempty"`
}

// Page is a page of transfers plus pagination metadata.
type Page struct {
	Transfers  []Transfer `json:"transfers"`
	Total      int        `json:"total"`
	Limit      int        `json:"limit"`
	Offset     int        `json:"offset"`
	NextCursor *string    `json:"nextCursor"`
}

// ListParams holds the optional filters shared by the transfer list endpoints.
type ListParams struct {
	ContractID string
	Token      string
	EventType  []string
	FromLedger *int
	ToLedger   *int
	FromDate   string
	ToDate     string
	Limit      *int
	Offset     *int
	Cursor     string
}

func (p *ListParams) Query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	wraith.AddString(q, "contractId", p.ContractID)
	wraith.AddString(q, "token", p.Token)
	wraith.AddStrings(q, "eventType", p.EventType)
	wraith.AddInt(q, "fromLedger", p.FromLedger)
	wraith.AddInt(q, "toLedger", p.ToLedger)
	wraith.AddString(q, "fromDate", p.FromDate)
	wraith.AddString(q, "toDate", p.ToDate)
	wraith.AddInt(q, "limit", p.Limit)
	wraith.AddInt(q, "offset", p.Offset)
	wraith.AddString(q, "cursor", p.Cursor)
	return q
}

// Incoming returns transfers received by address (GET /transfers/incoming/{address}).
func (t *Client) Incoming(ctx context.Context, address string, params *ListParams) (*Page, error) {
	var page Page
	if err := t.c.Get(ctx, "/transfers/incoming/"+url.PathEscape(address), params.Query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}

// Outgoing returns transfers sent by address (GET /transfers/outgoing/{address}).
func (t *Client) Outgoing(ctx context.Context, address string, params *ListParams) (*Page, error) {
	var page Page
	if err := t.c.Get(ctx, "/transfers/outgoing/"+url.PathEscape(address), params.Query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}

// ForAddress returns all transfers touching address (GET /transfers/address/{address}).
func (t *Client) ForAddress(ctx context.Context, address string, params *ListParams) (*Page, error) {
	var page Page
	if err := t.c.Get(ctx, "/transfers/address/"+url.PathEscape(address), params.Query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}

// ByTx returns the transfers in a single transaction (GET /transfers/tx/{txHash}).
func (t *Client) ByTx(ctx context.Context, txHash string) ([]Transfer, error) {
	var transfers []Transfer
	if err := t.c.Get(ctx, "/transfers/tx/"+url.PathEscape(txHash), nil, &transfers); err != nil {
		return nil, err
	}
	return transfers, nil
}
