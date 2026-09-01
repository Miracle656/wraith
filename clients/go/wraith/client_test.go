package wraith_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestGetDecodesJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/thing" {
			t.Errorf("path = %q, want /thing", r.URL.Path)
		}
		if got := r.URL.Query().Get("a"); got != "1" {
			t.Errorf("query a = %q, want 1", got)
		}
		if r.Header.Get("X-Api-Key") != "secret" {
			t.Errorf("missing custom header")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"name":"ok"}`))
	}))
	defer srv.Close()

	c := wraith.New(srv.URL, wraith.WithHeader("X-Api-Key", "secret"))
	var out struct {
		Name string `json:"name"`
	}
	q := url.Values{}
	q.Set("a", "1")
	if err := c.Get(context.Background(), "/thing", q, &out); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if out.Name != "ok" {
		t.Errorf("name = %q, want ok", out.Name)
	}
}

func TestGetReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()

	c := wraith.New(srv.URL)
	err := c.Get(context.Background(), "/x", nil, nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	apiErr, ok := err.(*wraith.APIError)
	if !ok {
		t.Fatalf("error type = %T, want *wraith.APIError", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status = %d, want 500", apiErr.StatusCode)
	}
	if apiErr.Message != "boom" {
		t.Errorf("message = %q, want boom", apiErr.Message)
	}
}

func TestBaseURLTrailingSlashTrimmed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Assert inside the handler so there is no cross-goroutine shared state
		// for the race detector to flag.
		if r.URL.Path != "/status" {
			t.Errorf("path = %q, want /status (no double slash)", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := wraith.New(srv.URL+"/", wraith.WithHTTPClient(&http.Client{}))
	if err := c.Get(context.Background(), "/status", nil, nil); err != nil {
		t.Fatalf("Get: %v", err)
	}
}
