package wraith.authz

import future.keywords.if
import future.keywords.in

# ── Default deny ──────────────────────────────────────────────────────────────
default allow := false
default deny_reason := "request denied by default policy"
default deny_rule := "default_deny"

# ── Public routes — no token required ─────────────────────────────────────────
public_paths := {"/healthz", "/readyz", "/status"}

allow if {
  input.path in public_paths
}

deny_reason := "public path"   if { input.path in public_paths }
deny_rule   := "public_allow"  if { input.path in public_paths }

# ── Authenticated routes — valid bearer token required ─────────────────────────
allow if {
  not (input.path in public_paths)
  valid_token
}

# Token is valid when it is a non-empty string present in the request headers.
# In production this should be replaced with JWT signature verification or
# an OPA token introspection call.
valid_token if {
  token := input.token
  count(token) > 0
}

# ── Admin-only routes ─────────────────────────────────────────────────────────
admin_prefixes := {"/admin", "/internal"}

allow if {
  some prefix in admin_prefixes
  startswith(input.path, prefix)
  input.role == "admin"
  valid_token
}

# ── Deny reasons for authenticated routes ─────────────────────────────────────
deny_reason := "missing or empty bearer token" if {
  not (input.path in public_paths)
  not valid_token
}

deny_rule := "require_bearer_token" if {
  not (input.path in public_paths)
  not valid_token
}

deny_reason := "admin role required" if {
  some prefix in admin_prefixes
  startswith(input.path, prefix)
  input.role != "admin"
  valid_token
}

deny_rule := "require_admin_role" if {
  some prefix in admin_prefixes
  startswith(input.path, prefix)
  input.role != "admin"
  valid_token
}

# ── Rate-limit guard (per-role) ────────────────────────────────────────────────
# Callers inject `input.request_count` and `input.rate_limit` when available.
deny_reason := "rate limit exceeded" if {
  not (input.path in public_paths)
  valid_token
  input.request_count > input.rate_limit
}

deny_rule := "rate_limit_exceeded" if {
  not (input.path in public_paths)
  valid_token
  input.request_count > input.rate_limit
}