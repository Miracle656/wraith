package status_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/status"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestGet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"lastIndexedLedger":100,"latestLedger":102,"lagLedgers":2,"startedAt":"t","uptimeSeconds":3600,"totalIndexed":5000}`))
	}))
	defer srv.Close()

	c := status.New(wraith.New(srv.URL))
	st, err := c.Get(context.Background())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !st.OK || st.LagLedgers != 2 || st.TotalIndexed != 5000 {
		t.Errorf("unexpected status: %+v", st)
	}
}
