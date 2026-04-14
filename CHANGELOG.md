# Changelog

All notable changes to Wraith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog

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
