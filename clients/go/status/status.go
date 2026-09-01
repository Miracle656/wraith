// Package status is the Wraith client for indexer status endpoints.
package status

import (
	"context"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /status endpoint.
type Client struct {
	c *wraith.Client
}

// New returns a status client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Status reports the indexer's progress and lag.
type Status struct {
	OK                bool   `json:"ok"`
	LastIndexedLedger int64  `json:"lastIndexedLedger"`
	LatestLedger      int64  `json:"latestLedger"`
	LagLedgers        int64  `json:"lagLedgers"`
	StartedAt         string `json:"startedAt"`
	UptimeSeconds     int64  `json:"uptimeSeconds"`
	TotalIndexed      int64  `json:"totalIndexed"`
}

// Get returns the current indexer status (GET /status).
func (s *Client) Get(ctx context.Context) (*Status, error) {
	var st Status
	if err := s.c.Get(ctx, "/status", nil, &st); err != nil {
		return nil, err
	}
	return &st, nil
}
