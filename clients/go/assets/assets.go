// Package assets is the Wraith client for asset-level endpoints.
package assets

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /assets endpoints.
type Client struct {
	c *wraith.Client
}

// New returns an assets client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// PopularAsset is one asset on the /assets/popular leaderboard. Volume is kept
// as a string to preserve full i128 precision.
type PopularAsset struct {
	ContractID    string `json:"contractId"`
	TransferCount int    `json:"transferCount"`
	Volume        string `json:"volume"`
	DisplayVolume string `json:"displayVolume,omitempty"`
}

// Popular is the /assets/popular response: a ranked list plus the query window.
type Popular struct {
	Window string         `json:"window"`
	By     string         `json:"by"`
	Assets []PopularAsset `json:"assets"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

// PopularParams are the optional filters for PopularAssets.
type PopularParams struct {
	Window string // e.g. "24h", "7d"
	By     string // e.g. "volume", "count"
	Limit  *int
	Offset *int
}

func (p *PopularParams) query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	wraith.AddString(q, "window", p.Window)
	wraith.AddString(q, "by", p.By)
	wraith.AddInt(q, "limit", p.Limit)
	wraith.AddInt(q, "offset", p.Offset)
	return q
}

// PopularAssets returns the most-active assets (GET /assets/popular).
func (a *Client) PopularAssets(ctx context.Context, params *PopularParams) (*Popular, error) {
	var popular Popular
	if err := a.c.Get(ctx, "/assets/popular", params.query(), &popular); err != nil {
		return nil, err
	}
	return &popular, nil
}
