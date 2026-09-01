package wraith

import (
	"net/url"
	"strconv"
)

// AddString sets key=val on q when val is non-empty.
func AddString(q url.Values, key, val string) {
	if val != "" {
		q.Set(key, val)
	}
}

// AddInt sets key=*val on q when val is non-nil. Pointers distinguish "unset"
// from a meaningful zero (e.g. offset=0).
func AddInt(q url.Values, key string, val *int) {
	if val != nil {
		q.Set(key, strconv.Itoa(*val))
	}
}

// AddStrings appends one key=v entry per value (e.g. repeated eventType filters).
func AddStrings(q url.Values, key string, vals []string) {
	for _, v := range vals {
		if v != "" {
			q.Add(key, v)
		}
	}
}

// IntPtr is a convenience for setting optional int params: Limit: wraith.IntPtr(50).
func IntPtr(v int) *int { return &v }
