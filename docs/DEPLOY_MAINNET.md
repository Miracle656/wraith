# Mainnet Deployment Guide

Deploying Wraith on mainnet requires a more robust infrastructure setup than testnet due to the lack of free public resources and the need for high availability. 

When running both testnet and mainnet indexers, it is recommended to run them side-by-side as separate deployments (with separate databases) rather than combining them, ensuring one network's issues don't impact the other.

## 1. Database (Managed Postgres)

**Critical:** Do *not* use Render's free PostgreSQL for a mainnet deployment. Render deletes free databases after 90 days, which will destroy your indexed state.

- Use a durable managed Postgres provider such as **Neon** (or Supabase/AWS RDS).
- Supply the connection string in your environment variables as `DATABASE_URL`.
- Ensure you have a backup strategy. See the [Database Backup Workflow (W076)](../W076) runbook for instructions on how to back up your indexed data.

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

### Mainnet Deployment
```env
# Network Configuration
STELLAR_NETWORK=mainnet

# RPC Provider (Required for mainnet - use your actual provider URL with API key)
SOROBAN_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>

# Mainnet Native XLM SAC Contract ID
SAC_CONTRACT_IDS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# External Durable Database (e.g., Neon)
DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
```

### Testnet Deployment
```env
# Network Configuration
STELLAR_NETWORK=testnet

# RPC Provider (Optional - defaults to public testnet RPC)
SOROBAN_RPC_URL=

# Testnet Native XLM SAC Contract ID
SAC_CONTRACT_IDS=CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4

# Database
DATABASE_URL=postgresql://[user]:[password]@[host]/[dbname]?sslmode=require
```
