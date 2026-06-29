// Package accounts is the Wraith client for account-level endpoints.
package accounts

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/transfers"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /accounts endpoints.
type Client struct {
	c *wraith.Client
}

// New returns an accounts client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// AssetHolding is one row of an account's per-asset summary. Amounts are kept
// as strings to preserve full i128 precision.
type AssetHolding struct {
	ContractID           string  `json:"contractId"`
	TotalSent            string  `json:"totalSent"`
	TotalReceived        string  `json:"totalReceived"`
	Net                  string  `json:"net"`
	TxCount              int     `json:"txCount"`
	LastActivityAt       *string `json:"lastActivityAt"`
	DisplayTotalSent     string  `json:"displayTotalSent,omitempty"`
	DisplayTotalReceived string  `json:"displayTotalReceived,omitempty"`
	DisplayNet           string  `json:"displayNet,omitempty"`
}

// Summary is an account's holdings across every asset it has touched.
type Summary struct {
	Address string         `json:"address"`
	Assets  []AssetHolding `json:"assets"`
}

// Summary returns an account's per-asset holdings (GET /accounts/{address}/summary).
func (a *Client) Summary(ctx context.Context, address string) (*Summary, error) {
	var summary Summary
	if err := a.c.Get(ctx, "/accounts/"+url.PathEscape(address)+"/summary", nil, &summary); err != nil {
		return nil, err
	}
	return &summary, nil
}

// Transfers returns an account's transfers (GET /accounts/{address}/transfers).
// It reuses the shared transfers.ListParams filters and transfers.Page shape.
func (a *Client) Transfers(ctx context.Context, address string, params *transfers.ListParams) (*transfers.Page, error) {
	var page transfers.Page
	if err := a.c.Get(ctx, "/accounts/"+url.PathEscape(address)+"/transfers", params.Query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}
