# Mainnet Deployment Guide

Deploying Wraith on mainnet requires a more robust infrastructure setup than testnet due to the lack of free public resources and the need for high availability. 

When running both testnet and mainnet indexers, it is recommended to run them side-by-side as separate deployments (with separate databases) rather than combining them, ensuring one network's issues don't impact the other. A single process *can* index both by setting `NETWORKS=testnet,mainnet` — see [DUAL_NETWORK.md](./DUAL_NETWORK.md) for the trade-offs.

## 1. Database (Managed Postgres)

**Critical:** Do *not* use Render's free PostgreSQL for a mainnet deployment. Render deletes free databases after 90 days, which will destroy your indexed state.

- Use a durable managed Postgres provider such as **Neon** (or Supabase/AWS RDS).
- Supply the connection string in your environment variables as `DATABASE_URL`.
- Set `DIRECT_DATABASE_URL` as well as `DATABASE_URL`. `prisma/schema.prisma` declares `directUrl = env("DIRECT_DATABASE_URL")`, and schema sync on boot fails without it. On a pooled provider, `DATABASE_URL` is the pooler endpoint and `DIRECT_DATABASE_URL` the direct one; on a non-pooled provider both hold the same value.
- Ensure you have a backup strategy. See the [backup and restore runbook](./backup-restore.md) for instructions on how to back up your indexed data.

## 2. Soroban RPC Provider

Unlike testnet, Stellar mainnet does not provide a free public Soroban RPC endpoint suitable for a production indexer.

- You must configure an external provider (e.g., Validation Cloud, Ankr) or run your own self-hosted RPC.
- Provide the endpoint URL in the `SOROBAN_RPC_URL` environment variable. 
- *Note:* Never commit your real RPC URL containing API keys to version control. Use the Render environment secrets instead.

## 3. Render Hosting & Keep-Alive

Wraith can run on Render's free web services, but with two important caveats:

1. **Sleep mode:** Render spins down free web services after 15 minutes of inactivity. For an indexer, sleeping means missing blocks. 
   - **Solution:** Use a service like **UptimeRobot** to ping your deployment's `/status` endpoint every 5 minutes to prevent it from sleeping.
2. **Usage caps:** Render has a 750 instance-hours/month free tier cap. This is roughly enough for exactly *one* always-on web service. If you are running both testnet and mainnet deployments on the free tier, one of them will run out of hours before the month ends unless you upgrade to a paid tier.

## 4. Environment Variables Matrix

Below is the environment configuration matrix for running Testnet vs. Mainnet side-by-side. Set these as secrets in your hosting provider.

> **Set `SAC_CONTRACT_IDS` explicitly on mainnet — do not rely on the built-in default.**
> The native XLM SAC address is derived from the network passphrase, so it differs per
> network, and the value the code falls back to when `SAC_CONTRACT_IDS` is unset is not
> currently correct for mainnet (tracked separately). Derive the address yourself and
> paste the result:
>
> ```js
> import { Asset, Networks } from '@stellar/stellar-sdk';
> Asset.native().contractId(Networks.PUBLIC);   // mainnet
> Asset.native().contractId(Networks.TESTNET);  // testnet
> ```

### Mainnet Deployment
```env
# Network Configuration
STELLAR_NETWORK=mainnet

# RPC Provider (Required for mainnet - use your actual provider URL with API key)
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>

# Mainnet Native XLM SAC Contract ID
#   = Asset.native().contractId(Networks.PUBLIC)
SAC_CONTRACT_IDS=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA

# External Durable Database (e.g., Neon)
DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
DIRECT_DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
```

### Testnet Deployment
```env
# Network Configuration
STELLAR_NETWORK=testnet

# RPC Provider (Optional - defaults to public testnet RPC)
SOROBAN_RPC_URL=

# Testnet Native XLM SAC Contract ID
#   = Asset.native().contractId(Networks.TESTNET)
SAC_CONTRACT_IDS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# Database
DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
DIRECT_DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
```
