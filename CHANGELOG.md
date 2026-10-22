# Changelog

All notable changes to Wraith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog
- `CORS_ALLOWED_ORIGINS` — the comma-separated list of browser origins allowed to call the surfaces that are not public. A new client is an environment change, not a change to the source.

### Changed
- **CORS is decided per surface instead of one global `Access-Control-Allow-Origin: *`.** The public read API, GraphQL, the fee quote and the offramp quotes stay open to every origin; the offramp orders, the naira rails, webhook subscription management, `/metrics` and any write nobody has classified yet are restricted to `CORS_ALLOWED_ORIGINS`. A request from any other origin is refused with `403` and the code `origin_not_allowed`, before the route runs.
  - **Breaking for browser clients.** A deployment with no `CORS_ALLOWED_ORIGINS` set lets no browser origin call those surfaces; add your web wallet's origin to it. Requests with no `Origin` header are unaffected, so the mobile app, server-to-server callers and `curl` keep working as they did.
  - `POST /webhooks/linq` is the payout provider's callback: it gets no CORS headers, and it is never refused by the origin policy, so a payment rail cannot stop working because the list changed.

## [1.1.0] — PR #6

### Added
- Combined transfers endpoint: `GET /transfers/address/:address?direction=incoming|outgoing|both`
- `displayAmount` (human-readable) in transfer responses
- `fromDate` / `toDate` query filters
- `eventType` query filter
- `GET /summary/:address` aggregated transfer summary

## [1.0.0] — Initial release

### Added
- Express REST API with `/transfers/incoming/:address` and `/transfers/outgoing/:address`
- Soroban event indexer using `fetchEventsSafe` with bisection to handle Protocol 22 XDR decode errors
- SEP-41 / CAP-67 token transfer decoding
- Prisma schema for events and transfers
- Dockerfile + docker-compose
- Deployed on Render at https://wraith-0jo1.onrender.com

[Unreleased]: https://github.com/Miracle656/wraith/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Miracle656/wraith/releases/tag/v1.1.0
[1.0.0]: https://github.com/Miracle656/wraith/releases/tag/v1.0.0
