// Package webhooks is the Wraith client for webhook subscription endpoints.
package webhooks

import (
	"context"
	"net/url"
	"strconv"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /webhooks endpoints.
type Client struct {
	c *wraith.Client
}

// New returns a webhooks client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Subscription is a registered webhook subscription.
type Subscription struct {
	ID        int64   `json:"id"`
	URL       string  `json:"url"`
	Filter    *string `json:"filter"`
	Active    bool    `json:"active"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// SubscriptionList is the /webhooks response.
type SubscriptionList struct {
	Subscriptions []Subscription `json:"subscriptions"`
}

// Delivery is one webhook delivery attempt record.
type Delivery struct {
	ID             int64   `json:"id"`
	EventID        string  `json:"eventId"`
	Status         string  `json:"status"`
	Attempts       int     `json:"attempts"`
	LastStatusCode *int    `json:"lastStatusCode"`
	LastError      *string `json:"lastError"`
	NextRetryAt    *string `json:"nextRetryAt"`
	DeliveredAt    *string `json:"deliveredAt"`
	CreatedAt      string  `json:"createdAt"`
}

// DeliveryList is the /webhooks/{id}/deliveries response.
type DeliveryList struct {
	Deliveries []Delivery `json:"deliveries"`
	Total      int        `json:"total"`
	Limit      int        `json:"limit"`
	Offset     int        `json:"offset"`
}

// DeliveriesParams are the optional filters for Deliveries.
type DeliveriesParams struct {
	Status string
	Limit  *int
	Offset *int
}

func (p *DeliveriesParams) query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	wraith.AddString(q, "status", p.Status)
	wraith.AddInt(q, "limit", p.Limit)
	wraith.AddInt(q, "offset", p.Offset)
	return q
}

// List returns all webhook subscriptions (GET /webhooks).
func (w *Client) List(ctx context.Context) (*SubscriptionList, error) {
	var list SubscriptionList
	if err := w.c.Get(ctx, "/webhooks", nil, &list); err != nil {
		return nil, err
	}
	return &list, nil
}

// Deliveries returns a webhook's delivery log (GET /webhooks/{id}/deliveries).
func (w *Client) Deliveries(ctx context.Context, id int64, params *DeliveriesParams) (*DeliveryList, error) {
	var list DeliveryList
	path := "/webhooks/" + strconv.FormatInt(id, 10) + "/deliveries"
	if err := w.c.Get(ctx, path, params.query(), &list); err != nil {
		return nil, err
	}
	return &list, nil
}
