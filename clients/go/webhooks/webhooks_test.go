package webhooks_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/webhooks"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/webhooks" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"subscriptions":[{"id":1,"url":"https://h","filter":null,"active":true,"createdAt":"t","updatedAt":"t"}]}`))
	}))
	defer srv.Close()

	c := webhooks.New(wraith.New(srv.URL))
	list, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Subscriptions) != 1 || list.Subscriptions[0].ID != 1 || !list.Subscriptions[0].Active {
		t.Errorf("unexpected list: %+v", list)
	}
}

func TestDeliveries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/webhooks/7/deliveries" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("status") != "failed" {
			t.Errorf("status = %q, want failed", r.URL.Query().Get("status"))
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"total":1,"limit":50,"offset":0,
			"deliveries":[{"id":9,"eventId":"e","status":"failed","attempts":3,
			"lastStatusCode":500,"lastError":"boom","nextRetryAt":null,"deliveredAt":null,"createdAt":"t"}]}`))
	}))
	defer srv.Close()

	c := webhooks.New(wraith.New(srv.URL))
	list, err := c.Deliveries(context.Background(), 7, &webhooks.DeliveriesParams{Status: "failed"})
	if err != nil {
		t.Fatalf("Deliveries: %v", err)
	}
	if len(list.Deliveries) != 1 || list.Deliveries[0].Status != "failed" || list.Deliveries[0].Attempts != 3 {
		t.Fatalf("unexpected deliveries: %+v", list)
	}
	if list.Deliveries[0].LastStatusCode == nil || *list.Deliveries[0].LastStatusCode != 500 {
		t.Errorf("lastStatusCode = %v, want 500", list.Deliveries[0].LastStatusCode)
	}
}
