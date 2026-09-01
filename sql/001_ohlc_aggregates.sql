-- ─── Enable TimescaleDB Extension ──────────────────────────────────────────────
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
-- Run separately: psql -d wraith -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

-- ─── Materialized OHLC Tables (for PostgreSQL without TimescaleDB) ───────────
-- If TimescaleDB is available, these can be replaced with continuous aggregates.
-- For now, we use materialized views + scheduled refresh via pg_cron.

CREATE SCHEMA IF NOT EXISTS ohlc;

-- ─── 1-minute OHLC ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ohlc.candles_1m (
  time_bucket        TIMESTAMP NOT NULL,
  contract_id         STRING NOT NULL,
  open_price          NUMERIC NOT NULL,
  high_price          NUMERIC NOT NULL,
  low_price           NUMERIC NOT NULL,
  close_price         NUMERIC NOT NULL,
  volume              NUMERIC NOT NULL,
  tx_count            INT NOT NULL,
  PRIMARY KEY (time_bucket, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_candles_1m_time ON ohlc.candles_1m (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_candles_1m_contract ON ohlc.candles_1m (contract_id, time_bucket DESC);

-- ─── 1-hour OHLC ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ohlc.candles_1h (
  time_bucket        TIMESTAMP NOT NULL,
  contract_id         STRING NOT NULL,
  open_price          NUMERIC NOT NULL,
  high_price          NUMERIC NOT NULL,
  low_price           NUMERIC NOT NULL,
  close_price         NUMERIC NOT NULL,
  volume              NUMERIC NOT NULL,
  tx_count            INT NOT NULL,
  PRIMARY KEY (time_bucket, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_candles_1h_time ON ohlc.candles_1h (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_candles_1h_contract ON ohlc.candles_1h (contract_id, time_bucket DESC);

-- ─── 1-day OHLC ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ohlc.candles_1d (
  time_bucket        TIMESTAMP NOT NULL,
  contract_id         STRING NOT NULL,
  open_price          NUMERIC NOT NULL,
  high_price          NUMERIC NOT NULL,
  low_price           NUMERIC NOT NULL,
  close_price         NUMERIC NOT NULL,
  volume              NUMERIC NOT NULL,
  tx_count            INT NOT NULL,
  PRIMARY KEY (time_bucket, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_candles_1d_time ON ohlc.candles_1d (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_candles_1d_contract ON ohlc.candles_1d (contract_id, time_bucket DESC);

-- ─── Last Update Tracking ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ohlc.last_update (
  bucket_size         STRING PRIMARY KEY,  -- '1m', '1h', '1d'
  last_update         TIMESTAMP NOT NULL,
  last_ledger         INT NOT NULL
);

INSERT INTO ohlc.last_update (bucket_size, last_update, last_ledger)
VALUES ('1m', NOW() - INTERVAL '24 hours', 0),
       ('1h', NOW() - INTERVAL '24 hours', 0),
       ('1d', NOW() - INTERVAL '24 hours', 0)
ON CONFLICT (bucket_size) DO NOTHING;

-- ─── Refresh 1-minute OHLC ────────────────────────────────────────────────────
-- This stored procedure computes OHLC from raw transfers incrementally.
-- It only processes transfers since the last update to minimize cost.
CREATE OR REPLACE FUNCTION ohlc.refresh_candles_1m()
RETURNS TABLE(rows_inserted INT, rows_updated INT) AS $$
DECLARE
  v_last_update TIMESTAMP;
  v_last_ledger INT;
  v_new_ledger INT;
  v_rows_ins INT := 0;
  v_rows_upd INT := 0;
BEGIN
  -- Get last update time
  SELECT last_update, last_ledger INTO v_last_update, v_last_ledger
  FROM ohlc.last_update
  WHERE bucket_size = '1m';

  -- Find max ledger processed
  SELECT MAX(ledger) INTO v_new_ledger
  FROM wraith."TokenTransfer"
  WHERE ledger > v_last_ledger;

  IF v_new_ledger IS NULL THEN
    RETURN QUERY SELECT 0::INT, 0::INT;
    RETURN;
  END IF;

  -- Compute and upsert 1-minute candles from new transfers
  WITH new_candles AS (
    SELECT
      DATE_TRUNC('minute', "ledgerClosedAt") AS time_bucket,
      "contractId" AS contract_id,
      CAST(MIN(CAST("amount" AS NUMERIC)) AS NUMERIC) AS low_price,
      CAST(MAX(CAST("amount" AS NUMERIC)) AS NUMERIC) AS high_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) FILTER (WHERE TRUE) ORDER BY "ledgerClosedAt" ASC)[1] AS NUMERIC) AS open_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) ORDER BY "ledgerClosedAt" DESC)[1] AS NUMERIC) AS close_price,
      CAST(SUM(CAST("amount" AS NUMERIC)) AS NUMERIC) AS volume,
      COUNT(*) AS tx_count
    FROM wraith."TokenTransfer"
    WHERE ledger > v_last_ledger
      AND "eventType" = 'transfer'
    GROUP BY DATE_TRUNC('minute', "ledgerClosedAt"), "contractId"
  )
  INSERT INTO ohlc.candles_1m (time_bucket, contract_id, open_price, high_price, low_price, close_price, volume, tx_count)
  SELECT * FROM new_candles
  ON CONFLICT (time_bucket, contract_id) DO UPDATE SET
    high_price = GREATEST(ohlc.candles_1m.high_price, EXCLUDED.high_price),
    low_price = LEAST(ohlc.candles_1m.low_price, EXCLUDED.low_price),
    close_price = EXCLUDED.close_price,
    volume = ohlc.candles_1m.volume + EXCLUDED.volume,
    tx_count = ohlc.candles_1m.tx_count + EXCLUDED.tx_count;

  GET DIAGNOSTICS v_rows_ins = ROW_COUNT;

  -- Update tracking
  UPDATE ohlc.last_update
  SET last_update = NOW(), last_ledger = v_new_ledger
  WHERE bucket_size = '1m';

  RETURN QUERY SELECT v_rows_ins, 0::INT;
END;
$$ LANGUAGE plpgsql;

-- ─── Refresh 1-hour OHLC ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ohlc.refresh_candles_1h()
RETURNS TABLE(rows_inserted INT, rows_updated INT) AS $$
DECLARE
  v_last_update TIMESTAMP;
  v_last_ledger INT;
  v_new_ledger INT;
  v_rows_ins INT := 0;
BEGIN
  SELECT last_update, last_ledger INTO v_last_update, v_last_ledger
  FROM ohlc.last_update
  WHERE bucket_size = '1h';

  SELECT MAX(ledger) INTO v_new_ledger
  FROM wraith."TokenTransfer"
  WHERE ledger > v_last_ledger;

  IF v_new_ledger IS NULL THEN
    RETURN QUERY SELECT 0::INT, 0::INT;
    RETURN;
  END IF;

  WITH new_candles AS (
    SELECT
      DATE_TRUNC('hour', "ledgerClosedAt") AS time_bucket,
      "contractId" AS contract_id,
      CAST(MIN(CAST("amount" AS NUMERIC)) AS NUMERIC) AS low_price,
      CAST(MAX(CAST("amount" AS NUMERIC)) AS NUMERIC) AS high_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) ORDER BY "ledgerClosedAt" ASC)[1] AS NUMERIC) AS open_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) ORDER BY "ledgerClosedAt" DESC)[1] AS NUMERIC) AS close_price,
      CAST(SUM(CAST("amount" AS NUMERIC)) AS NUMERIC) AS volume,
      COUNT(*) AS tx_count
    FROM wraith."TokenTransfer"
    WHERE ledger > v_last_ledger
      AND "eventType" = 'transfer'
    GROUP BY DATE_TRUNC('hour', "ledgerClosedAt"), "contractId"
  )
  INSERT INTO ohlc.candles_1h (time_bucket, contract_id, open_price, high_price, low_price, close_price, volume, tx_count)
  SELECT * FROM new_candles
  ON CONFLICT (time_bucket, contract_id) DO UPDATE SET
    high_price = GREATEST(ohlc.candles_1h.high_price, EXCLUDED.high_price),
    low_price = LEAST(ohlc.candles_1h.low_price, EXCLUDED.low_price),
    close_price = EXCLUDED.close_price,
    volume = ohlc.candles_1h.volume + EXCLUDED.volume,
    tx_count = ohlc.candles_1h.tx_count + EXCLUDED.tx_count;

  GET DIAGNOSTICS v_rows_ins = ROW_COUNT;

  UPDATE ohlc.last_update
  SET last_update = NOW(), last_ledger = v_new_ledger
  WHERE bucket_size = '1h';

  RETURN QUERY SELECT v_rows_ins, 0::INT;
END;
$$ LANGUAGE plpgsql;

-- ─── Refresh 1-day OHLC ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ohlc.refresh_candles_1d()
RETURNS TABLE(rows_inserted INT, rows_updated INT) AS $$
DECLARE
  v_last_update TIMESTAMP;
  v_last_ledger INT;
  v_new_ledger INT;
  v_rows_ins INT := 0;
BEGIN
  SELECT last_update, last_ledger INTO v_last_update, v_last_ledger
  FROM ohlc.last_update
  WHERE bucket_size = '1d';

  SELECT MAX(ledger) INTO v_new_ledger
  FROM wraith."TokenTransfer"
  WHERE ledger > v_last_ledger;

  IF v_new_ledger IS NULL THEN
    RETURN QUERY SELECT 0::INT, 0::INT;
    RETURN;
  END IF;

  WITH new_candles AS (
    SELECT
      DATE_TRUNC('day', "ledgerClosedAt") AS time_bucket,
      "contractId" AS contract_id,
      CAST(MIN(CAST("amount" AS NUMERIC)) AS NUMERIC) AS low_price,
      CAST(MAX(CAST("amount" AS NUMERIC)) AS NUMERIC) AS high_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) ORDER BY "ledgerClosedAt" ASC)[1] AS NUMERIC) AS open_price,
      CAST((ARRAY_AGG(CAST("amount" AS NUMERIC)) ORDER BY "ledgerClosedAt" DESC)[1] AS NUMERIC) AS close_price,
      CAST(SUM(CAST("amount" AS NUMERIC)) AS NUMERIC) AS volume,
      COUNT(*) AS tx_count
    FROM wraith."TokenTransfer"
    WHERE ledger > v_last_ledger
      AND "eventType" = 'transfer'
    GROUP BY DATE_TRUNC('day', "ledgerClosedAt"), "contractId"
  )
  INSERT INTO ohlc.candles_1d (time_bucket, contract_id, open_price, high_price, low_price, close_price, volume, tx_count)
  SELECT * FROM new_candles
  ON CONFLICT (time_bucket, contract_id) DO UPDATE SET
    high_price = GREATEST(ohlc.candles_1d.high_price, EXCLUDED.high_price),
    low_price = LEAST(ohlc.candles_1d.low_price, EXCLUDED.low_price),
    close_price = EXCLUDED.close_price,
    volume = ohlc.candles_1d.volume + EXCLUDED.volume,
    tx_count = ohlc.candles_1d.tx_count + EXCLUDED.tx_count;

  GET DIAGNOSTICS v_rows_ins = ROW_COUNT;

  UPDATE ohlc.last_update
  SET last_update = NOW(), last_ledger = v_new_ledger
  WHERE bucket_size = '1d';

  RETURN QUERY SELECT v_rows_ins, 0::INT;
END;
$$ LANGUAGE plpgsql;
