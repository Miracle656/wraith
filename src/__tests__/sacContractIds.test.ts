/**
 * Tests for resolveSacContractIds() — the multi-token SAC contract ID resolver.
 *
 * Covers:
 *  - SAC_CONTRACT_IDS env var (single + multiple contracts)
 *  - Legacy CONTRACT_IDS fallback
 *  - Default XLM SAC selection based on STELLAR_NETWORK
 *  - Whitespace trimming and empty-entry filtering
 *  - SAC_CONTRACT_IDS takes precedence over CONTRACT_IDS when both set
 */

import {
  resolveSacContractIds,
  DEFAULT_XLM_SAC_MAINNET,
  DEFAULT_XLM_SAC_TESTNET,
} from '../indexer';

// Save original env and restore after each test
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // Shallow-clone so mutations don't bleed between tests
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SAC_CONTRACT_IDS;
  delete process.env.CONTRACT_IDS;
  delete process.env.STELLAR_NETWORK;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ── SAC_CONTRACT_IDS env var ──────────────────────────────────────────────────
describe('resolveSacContractIds — SAC_CONTRACT_IDS env var', () => {
  it('returns a single contract ID when SAC_CONTRACT_IDS contains one value', () => {
    process.env.SAC_CONTRACT_IDS = 'CONTRACT_A';
    expect(resolveSacContractIds()).toEqual(['CONTRACT_A']);
  });

  it('returns multiple contract IDs when SAC_CONTRACT_IDS contains a comma-separated list', () => {
    process.env.SAC_CONTRACT_IDS = 'CONTRACT_A,CONTRACT_B,CONTRACT_C';
    expect(resolveSacContractIds()).toEqual(['CONTRACT_A', 'CONTRACT_B', 'CONTRACT_C']);
  });

  it('trims whitespace from each contract ID', () => {
    process.env.SAC_CONTRACT_IDS = '  CONTRACT_A , CONTRACT_B  ';
    expect(resolveSacContractIds()).toEqual(['CONTRACT_A', 'CONTRACT_B']);
  });

  it('filters out empty entries produced by trailing/double commas', () => {
    process.env.SAC_CONTRACT_IDS = 'CONTRACT_A,,CONTRACT_B,';
    expect(resolveSacContractIds()).toEqual(['CONTRACT_A', 'CONTRACT_B']);
  });
});

// ── Legacy CONTRACT_IDS fallback ─────────────────────────────────────────────
describe('resolveSacContractIds — legacy CONTRACT_IDS fallback', () => {
  it('falls back to CONTRACT_IDS when SAC_CONTRACT_IDS is unset', () => {
    process.env.CONTRACT_IDS = 'LEGACY_CONTRACT_A,LEGACY_CONTRACT_B';
    expect(resolveSacContractIds()).toEqual(['LEGACY_CONTRACT_A', 'LEGACY_CONTRACT_B']);
  });

  it('SAC_CONTRACT_IDS takes precedence over CONTRACT_IDS when both are set', () => {
    process.env.SAC_CONTRACT_IDS = 'NEW_CONTRACT_A';
    process.env.CONTRACT_IDS = 'LEGACY_CONTRACT_A';
    expect(resolveSacContractIds()).toEqual(['NEW_CONTRACT_A']);
  });
});

// ── Default XLM SAC fallback ─────────────────────────────────────────────────
describe('resolveSacContractIds — default XLM SAC when no env var is set', () => {
  it('defaults to the testnet XLM SAC when STELLAR_NETWORK is unset', () => {
    const result = resolveSacContractIds();
    expect(result).toEqual([DEFAULT_XLM_SAC_TESTNET]);
    expect(result).toHaveLength(1);
  });

  it('defaults to the testnet XLM SAC when STELLAR_NETWORK=testnet', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    expect(resolveSacContractIds()).toEqual([DEFAULT_XLM_SAC_TESTNET]);
  });

  it('defaults to the mainnet XLM SAC when STELLAR_NETWORK=mainnet', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    expect(resolveSacContractIds()).toEqual([DEFAULT_XLM_SAC_MAINNET]);
  });

  it('does not default to XLM SAC when SAC_CONTRACT_IDS is explicitly set', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    process.env.SAC_CONTRACT_IDS = 'CUSTOM_CONTRACT';
    const result = resolveSacContractIds();
    expect(result).toEqual(['CUSTOM_CONTRACT']);
    expect(result).not.toContain(DEFAULT_XLM_SAC_MAINNET);
  });

  it('does not default to XLM SAC when legacy CONTRACT_IDS is set', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.CONTRACT_IDS = 'LEGACY_CONTRACT';
    const result = resolveSacContractIds();
    expect(result).toEqual(['LEGACY_CONTRACT']);
    expect(result).not.toContain(DEFAULT_XLM_SAC_TESTNET);
  });
});

// ── Integration: multi-contract filtering via parseEvents ─────────────────────
// The parseEvents function already extracts contractId from each event, so
// multi-contract events flow through without extra filtering. This test confirms
// the resolver produces an array suitable for passing to fetchEventsSafe.
describe('resolveSacContractIds — output shape', () => {
  it('always returns a non-empty array', () => {
    const ids = resolveSacContractIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('returns an array of non-empty strings', () => {
    process.env.SAC_CONTRACT_IDS = 'CONTRACT_A,CONTRACT_B';
    const ids = resolveSacContractIds();
    ids.forEach((id) => {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  it('is directly passable to fetchEventsSafe as the contractIds argument', () => {
    process.env.SAC_CONTRACT_IDS = 'CCWAM1,CCWAM2';
    const ids = resolveSacContractIds();
    // fetchEventsSafe signature: (from, to, contractIds: string[], batchSize)
    // Confirm shape is string[] with 2 entries
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(['CCWAM1', 'CCWAM2']);
  });
});
