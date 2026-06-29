package accounts_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/accounts"
	"github.com/Miracle656/wraith/clients/go/transfers"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestSummary(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/accounts/GABC/summary" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"address":"GABC","assets":[{"contractId":"CABC","totalSent":"10","totalReceived":"30","net":"20","txCount":3}]}`))
	}))
	defer srv.Close()

	c := accounts.New(wraith.New(srv.URL))
	sum, err := c.Summary(context.Background(), "GABC")
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if sum.Address != "GABC" || len(sum.Assets) != 1 {
		t.Fatalf("unexpected summary: %+v", sum)
	}
	if sum.Assets[0].Net != "20" || sum.Assets[0].TxCount != 3 {
		t.Errorf("unexpected holding: %+v", sum.Assets[0])
	}
}

func TestTransfers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/accounts/GABC/transfers" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("offset") != "0" {
			t.Errorf("offset = %q, want 0", r.URL.Query().Get("offset"))
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"total":0,"limit":50,"offset":0,"nextCursor":null,"transfers":[]}`))
	}))
	defer srv.Close()

	c := accounts.New(wraith.New(srv.URL))
	page, err := c.Transfers(context.Background(), "GABC", &transfers.ListParams{Offset: wraith.IntPtr(0)})
	if err != nil {
		t.Fatalf("Transfers: %v", err)
	}
	if page.Limit != 50 {
		t.Errorf("limit = %d, want 50", page.Limit)
	}
}
