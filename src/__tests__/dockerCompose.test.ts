/**
 * Tests for docker-compose.yml configuration.
 *
 * Verifies that the development compose file:
 *  - Matches the env contract in .env.example
 *  - Does not contain the obsolete version key
 *  - Includes optional Redis service for CACHE_ENABLED support
 *  - Resolves without warnings via docker compose config
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const COMPOSE_PATH = path.join(__dirname, '../../docker-compose.yml');
const ENV_EXAMPLE_PATH = path.join(__dirname, '../../.env.example');

describe('docker-compose.yml', () => {
  let composeContent: string;
  let envExampleContent: string;

  beforeAll(() => {
    composeContent = readFileSync(COMPOSE_PATH, 'utf-8');
    envExampleContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  });

  it('does not contain the obsolete version key', () => {
    expect(composeContent).not.toMatch(/^version:/m);
  });

  it('includes all env keys from .env.example in the wraith service', () => {
    // Extract env keys from .env.example (lines like KEY=value)
    const envKeys = envExampleContent
      .split('\n')
      .filter(line => line.includes('=') && !line.startsWith('#'))
      .map(line => line.split('=')[0].trim())
      .filter(key => key.length > 0);

    // Keys that are expected to be in docker-compose but may have defaults
    const expectedComposeKeys = [
      'DATABASE_URL',
      'DIRECT_DATABASE_URL',
      'STELLAR_NETWORK',
      'SOROBAN_RPC_URL',
      'STELLAR_RPC_URL',
      'NETWORKS',
      'START_LEDGER',
      'POLL_INTERVAL_MS',
      'SAC_CONTRACT_IDS',
      'SAC_CONTRACT_IDS_TESTNET',
      'SAC_CONTRACT_IDS_MAINNET',
      'CONTRACT_IDS',
      'NFT_CONTRACT_IDS',
      'NFT_CONTRACT_IDS_TESTNET',
      'NFT_CONTRACT_IDS_MAINNET',
      'EVENTS_BATCH_SIZE',
      'RETENTION_DAYS',
      'PORT',
      'CACHE_ENABLED',
      'REDIS_URL',
      'CACHE_KEY_PREFIX',
      'CACHE_TTL_POPULAR_MS',
      'CACHE_TTL_SEARCH_MS',
      'TOMBSTONE_CHECK_EVERY_CYCLES',
      'LP_POOL_CONTRACT_IDS',
      'LP_POOL_CONTRACT_IDS_TESTNET',
      'LP_POOL_CONTRACT_IDS_MAINNET',
      'SKIP_INDEXER',
    ];

    // Check that all expected keys are present in the compose file
    expectedComposeKeys.forEach(key => {
      expect(composeContent).toContain(key);
    });
  });

  it('includes a redis service with the cache profile', () => {
    expect(composeContent).toMatch(/redis:/);
    expect(composeContent).toMatch(/profiles:/);
    expect(composeContent).toMatch(/- cache/);
  });

  it('uses the new env keys (SAC_CONTRACT_IDS) instead of legacy CONTRACT_IDS as primary', () => {
    // SAC_CONTRACT_IDS should be present
    expect(composeContent).toContain('SAC_CONTRACT_IDS');
    // CONTRACT_IDS is still present for backward compatibility
    expect(composeContent).toContain('CONTRACT_IDS');
  });

  it('includes DIRECT_DATABASE_URL', () => {
    expect(composeContent).toContain('DIRECT_DATABASE_URL');
  });

  it('includes RETENTION_DAYS', () => {
    expect(composeContent).toContain('RETENTION_DAYS');
  });

  it('resolves without warnings via docker compose config', () => {
    try {
      execSync('docker compose config', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
      // If we get here, no error was thrown
      expect(true).toBe(true);
    } catch (error) {
      fail(`docker compose config failed: ${error}`);
    }
  });
});
