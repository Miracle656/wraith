package wraith.authz_test

import data.wraith.authz
import future.keywords.if

# ── Public paths ──────────────────────────────────────────────────────────────
test_healthz_allowed if {
  authz.allow with input as {"path": "/healthz", "token": "", "role": ""}
}

test_readyz_allowed if {
  authz.allow with input as {"path": "/readyz", "token": "", "role": ""}
}

test_status_allowed if {
  authz.allow with input as {"path": "/status", "token": "", "role": ""}
}

# ── Authenticated routes ───────────────────────────────────────────────────────
test_authed_route_allowed if {
  authz.allow with input as {"path": "/transfers/incoming/GADDR", "token": "tok_valid", "role": "user"}
}

test_authed_route_denied_no_token if {
  not authz.allow with input as {"path": "/transfers/incoming/GADDR", "token": "", "role": "user"}
}

# ── Admin routes ──────────────────────────────────────────────────────────────
test_admin_route_allowed if {
  authz.allow with input as {"path": "/admin/config", "token": "tok_admin", "role": "admin"}
}

test_admin_route_denied_non_admin if {
  not authz.allow with input as {"path": "/admin/config", "token": "tok_user", "role": "user"}
}

# ── Deny reasons ──────────────────────────────────────────────────────────────
test_deny_reason_no_token if {
  authz.deny_reason == "missing or empty bearer token" with input as {
    "path": "/transfers/incoming/GADDR", "token": "", "role": "user",
  }
}

test_deny_rule_no_token if {
  authz.deny_rule == "require_bearer_token" with input as {
    "path": "/transfers/incoming/GADDR", "token": "", "role": "user",
  }
}

test_deny_reason_admin_required if {
  authz.deny_reason == "admin role required" with input as {
    "path": "/admin/config", "token": "tok_user", "role": "user",
  }
}