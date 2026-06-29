package assets_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/assets"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestPopularAssets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/assets/popular" {
			t.Errorf("path = %q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("window") != "24h" || q.Get("by") != "volume" {
			t.Errorf("query = %v", q)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"window":"24h","by":"volume","total":1,"limit":10,"offset":0,
			"assets":[{"contractId":"CABC","transferCount":5,"volume":"100","displayVolume":"1.0"}]}`))
	}))
	defer srv.Close()

	c := assets.New(wraith.New(srv.URL))
	pop, err := c.PopularAssets(context.Background(), &assets.PopularParams{
		Window: "24h",
		By:     "volume",
		Limit:  wraith.IntPtr(10),
	})
	if err != nil {
		t.Fatalf("PopularAssets: %v", err)
	}
	if pop.Window != "24h" || len(pop.Assets) != 1 {
		t.Fatalf("unexpected response: %+v", pop)
	}
	if pop.Assets[0].ContractID != "CABC" || pop.Assets[0].TransferCount != 5 {
		t.Errorf("unexpected asset: %+v", pop.Assets[0])
	}
}
