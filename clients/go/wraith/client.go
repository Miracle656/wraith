// Package wraith provides the shared transport used by the resource-specific
// Wraith API client packages (transfers, accounts, assets, nfts, webhooks,
// status). Construct a *Client with New and hand it to a resource package:
//
//	c := wraith.New("https://wraith.example.com")
//	tc := transfers.New(c)
//	page, err := tc.Incoming(ctx, "GABC...", nil)
package wraith

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultTimeout is applied when no custom *http.Client is supplied.
const DefaultTimeout = 30 * time.Second

// Client is a thin, shared HTTP wrapper over the Wraith REST API. It is safe
// for concurrent use.
type Client struct {
	baseURL    string
	httpClient *http.Client
	headers    map[string]string
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient sets a custom *http.Client (e.g. with a different timeout or
// transport).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		if h != nil {
			c.httpClient = h
		}
	}
}

// WithHeader adds a header sent with every request (e.g. an API key).
func WithHeader(key, value string) Option {
	return func(c *Client) {
		c.headers[key] = value
	}
}

// New creates a Client for the Wraith API rooted at baseURL.
func New(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: DefaultTimeout},
		headers:    make(map[string]string),
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// APIError is returned when the API responds with a non-2xx status.
type APIError struct {
	// StatusCode is the HTTP status code of the response.
	StatusCode int
	// Message is the API's "error" field, or the raw body when absent.
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("wraith: api error %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("wraith: api error %d", e.StatusCode)
}

// Get performs a GET against path (e.g. "/transfers/incoming/GABC"), attaching
// the given query, and decodes the JSON response body into out. A non-2xx
// status yields an *APIError. It is exported so resource packages in this
// module can share one transport.
func (c *Client) Get(ctx context.Context, path string, query url.Values, out any) error {
	u := c.baseURL + path
	if enc := query.Encode(); enc != "" {
		u += "?" + enc
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return fmt.Errorf("wraith: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("wraith: request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("wraith: read body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode, Message: errorMessage(body)}
	}

	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("wraith: decode response: %w", err)
		}
	}
	return nil
}

// errorMessage extracts the API's {"error": "..."} field, falling back to the
// trimmed raw body.
func errorMessage(body []byte) string {
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != "" {
		return parsed.Error
	}
	return strings.TrimSpace(string(body))
}
