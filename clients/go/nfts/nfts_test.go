package nfts_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/nfts"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestTransfers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nfts/transfers" {
			t.Errorf("path = %q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("contract") != "CNFT" || q.Get("token_id") != "42" {
			t.Errorf("query = %v", q)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"total":1,"limit":50,"offset":0,"nextCursor":null,
			"transfers":[{"id":1,"contractId":"CNFT","tokenId":"42","fromAddress":null,
			"toAddress":"GABC","ledger":7,"ledgerClosedAt":"t","txHash":"h","eventId":"e","createdAt":"t"}]}`))
	}))
	defer srv.Close()

	c := nfts.New(wraith.New(srv.URL))
	page, err := c.Transfers(context.Background(), &nfts.TransfersParams{
		Contract: "CNFT",
		TokenID:  "42",
	})
	if err != nil {
		t.Fatalf("Transfers: %v", err)
	}
	if len(page.Transfers) != 1 || page.Transfers[0].TokenID != "42" {
		t.Fatalf("unexpected page: %+v", page)
	}
	if page.Transfers[0].FromAddress != nil {
		t.Errorf("fromAddress = %v, want nil", *page.Transfers[0].FromAddress)
	}
}
