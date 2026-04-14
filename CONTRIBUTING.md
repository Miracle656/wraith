# Contributing to Wraith

Wraith is a Soroban event indexer that fills the Horizon gap for SEP-41 / CAP-67 token transfers. Contributions welcome — tests, decoder improvements, new endpoints, docs.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/Miracle656/wraith/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)

## Repository layout

```
wraith/
├── src/
│   ├── index.ts           # Express entry point
│   ├── indexer/           # Event ingestion + bisection
│   ├── decoder/           # XDR event decoding (SEP-41 / CAP-67)
│   ├── routes/            # REST endpoints
│   └── db.ts              # Prisma client
└── prisma/
    └── schema.prisma
```

## Development setup

### Prerequisites
- **Node.js 20+**
- **PostgreSQL**

### Clone and install

```bash
git clone https://github.com/Miracle656/wraith.git
cd wraith
npm install
cp .env.example .env   # fill in DATABASE_URL, RPC_URL, NETWORK_PASSPHRASE
npx prisma db push
npm run dev
```

API runs on `http://localhost:3000`.

### Environment variables
- `DATABASE_URL` — Postgres connection string
- `RPC_URL` — Soroban RPC URL (e.g. `https://soroban-testnet.stellar.org`)
- `NETWORK_PASSPHRASE` — Stellar network passphrase
- `START_LEDGER` — optional, where to begin indexing

## Commit conventions

- `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Keep PRs focused

## Before opening a PR

```bash
npx prisma generate
npx tsc --noEmit
npm run build
npm test --if-present
```

## Testing

Tests are being set up — see [`area:tests`](https://github.com/Miracle656/wraith/labels/area%3Atests). Candidates: XDR decoders, bisection logic, route handlers, DB queries.

## Questions

Open an [issue](https://github.com/Miracle656/wraith/issues) or start a [discussion](https://github.com/Miracle656/wraith/discussions).
