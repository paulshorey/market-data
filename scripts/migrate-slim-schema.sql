-- ============================================================================
-- Migration: Slim Schema
-- ============================================================================
-- Reduces candle tables from 54 columns to 21 columns.
--
-- Changes:
--   KEEP as-is:  cvd_open, cvd_high, cvd_low, cvd_close (CVD OHLC)
--   KEEP as-is:  trades, max_trade_size, big_trades, big_volume, divergence
--   RENAME:      vd_close -> vd              (drop vd_open, vd_high, vd_low)
--   RENAME:      vd_ratio_close -> vd_ratio  (drop vd_ratio_open, vd_ratio_high, vd_ratio_low)
--   RENAME:      book_imbalance_close -> book_imbalance (drop _open/_high/_low)
--   RENAME:      price_pct_close -> price_pct (drop _open/_high/_low)
--   REMOVE:      vwap_open/high/low/close     (per-candle VWAP not useful)
--   REMOVE:      spread_bps_open/high/low/close (derivable, low value as stored column)
--   REMOVE:      avg_trade_size_open/high/low/close (redundant: volume/trades)
--   REMOVE:      evr_open/high/low/close      (derivable from price_pct + vd_ratio)
--   REMOVE:      smp_open/high/low/close      (arbitrary composite, obscures raw signals)
--   REMOVE:      vd_strength                  (broken for historical data)
--
-- Run against both candles-1m and candles-1s tables.
-- ============================================================================

BEGIN;

-- ============================================================================
-- candles-1m
-- ============================================================================

-- Step 1: Rename _close columns to base names (keeping the close value)
ALTER TABLE "candles-1m" RENAME COLUMN vd_close TO vd;
ALTER TABLE "candles-1m" RENAME COLUMN vd_ratio_close TO vd_ratio;
ALTER TABLE "candles-1m" RENAME COLUMN book_imbalance_close TO book_imbalance;
ALTER TABLE "candles-1m" RENAME COLUMN price_pct_close TO price_pct;

-- Step 2: Drop the _open/_high/_low columns for renamed metrics
ALTER TABLE "candles-1m"
  DROP COLUMN IF EXISTS vd_open,
  DROP COLUMN IF EXISTS vd_high,
  DROP COLUMN IF EXISTS vd_low,
  DROP COLUMN IF EXISTS vd_ratio_open,
  DROP COLUMN IF EXISTS vd_ratio_high,
  DROP COLUMN IF EXISTS vd_ratio_low,
  DROP COLUMN IF EXISTS book_imbalance_open,
  DROP COLUMN IF EXISTS book_imbalance_high,
  DROP COLUMN IF EXISTS book_imbalance_low,
  DROP COLUMN IF EXISTS price_pct_open,
  DROP COLUMN IF EXISTS price_pct_high,
  DROP COLUMN IF EXISTS price_pct_low;

-- Step 3: Drop all columns for fully removed metrics
ALTER TABLE "candles-1m"
  DROP COLUMN IF EXISTS vwap_open,
  DROP COLUMN IF EXISTS vwap_high,
  DROP COLUMN IF EXISTS vwap_low,
  DROP COLUMN IF EXISTS vwap_close,
  DROP COLUMN IF EXISTS spread_bps_open,
  DROP COLUMN IF EXISTS spread_bps_high,
  DROP COLUMN IF EXISTS spread_bps_low,
  DROP COLUMN IF EXISTS spread_bps_close,
  DROP COLUMN IF EXISTS avg_trade_size_open,
  DROP COLUMN IF EXISTS avg_trade_size_high,
  DROP COLUMN IF EXISTS avg_trade_size_low,
  DROP COLUMN IF EXISTS avg_trade_size_close,
  DROP COLUMN IF EXISTS evr_open,
  DROP COLUMN IF EXISTS evr_high,
  DROP COLUMN IF EXISTS evr_low,
  DROP COLUMN IF EXISTS evr_close,
  DROP COLUMN IF EXISTS smp_open,
  DROP COLUMN IF EXISTS smp_high,
  DROP COLUMN IF EXISTS smp_low,
  DROP COLUMN IF EXISTS smp_close,
  DROP COLUMN IF EXISTS vd_strength;

-- ============================================================================
-- candles-1s
-- ============================================================================

-- Step 1: Rename _close columns to base names
ALTER TABLE "candles-1s" RENAME COLUMN vd_close TO vd;
ALTER TABLE "candles-1s" RENAME COLUMN vd_ratio_close TO vd_ratio;
ALTER TABLE "candles-1s" RENAME COLUMN book_imbalance_close TO book_imbalance;
ALTER TABLE "candles-1s" RENAME COLUMN price_pct_close TO price_pct;

-- Step 2: Drop the _open/_high/_low columns for renamed metrics
ALTER TABLE "candles-1s"
  DROP COLUMN IF EXISTS vd_open,
  DROP COLUMN IF EXISTS vd_high,
  DROP COLUMN IF EXISTS vd_low,
  DROP COLUMN IF EXISTS vd_ratio_open,
  DROP COLUMN IF EXISTS vd_ratio_high,
  DROP COLUMN IF EXISTS vd_ratio_low,
  DROP COLUMN IF EXISTS book_imbalance_open,
  DROP COLUMN IF EXISTS book_imbalance_high,
  DROP COLUMN IF EXISTS book_imbalance_low,
  DROP COLUMN IF EXISTS price_pct_open,
  DROP COLUMN IF EXISTS price_pct_high,
  DROP COLUMN IF EXISTS price_pct_low;

-- Step 3: Drop all columns for fully removed metrics
ALTER TABLE "candles-1s"
  DROP COLUMN IF EXISTS vwap_open,
  DROP COLUMN IF EXISTS vwap_high,
  DROP COLUMN IF EXISTS vwap_low,
  DROP COLUMN IF EXISTS vwap_close,
  DROP COLUMN IF EXISTS spread_bps_open,
  DROP COLUMN IF EXISTS spread_bps_high,
  DROP COLUMN IF EXISTS spread_bps_low,
  DROP COLUMN IF EXISTS spread_bps_close,
  DROP COLUMN IF EXISTS avg_trade_size_open,
  DROP COLUMN IF EXISTS avg_trade_size_high,
  DROP COLUMN IF EXISTS avg_trade_size_low,
  DROP COLUMN IF EXISTS avg_trade_size_close,
  DROP COLUMN IF EXISTS evr_open,
  DROP COLUMN IF EXISTS evr_high,
  DROP COLUMN IF EXISTS evr_low,
  DROP COLUMN IF EXISTS evr_close,
  DROP COLUMN IF EXISTS smp_open,
  DROP COLUMN IF EXISTS smp_high,
  DROP COLUMN IF EXISTS smp_low,
  DROP COLUMN IF EXISTS smp_close,
  DROP COLUMN IF EXISTS vd_strength;

COMMIT;

-- ============================================================================
-- Verification: check the final schema matches expectations
-- ============================================================================
-- Run these after the migration to confirm:
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'candles-1m'
--   ORDER BY ordinal_position;
--
-- Expected 21 columns:
--   time, ticker, symbol, open, high, low, close, volume,
--   cvd_open, cvd_high, cvd_low, cvd_close,
--   vd, vd_ratio, book_imbalance, price_pct,
--   trades, max_trade_size, big_trades, big_volume, divergence
