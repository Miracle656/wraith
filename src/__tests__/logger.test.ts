import { getRequestId, logger, logProviderCall, safeDetails, withRequestId } from '../logger';

describe('structured logger', () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    console.warn = (line?: unknown) => {
      lines.push(String(line));
    };
    console.error = (line?: unknown) => {
      lines.push(String(line));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it('emits one JSON object per line with level and event', () => {
    logger.info('server.start', { port: 3000 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('server.start');
    expect(parsed.port).toBe(3000);
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('logs every provider call with route, status and duration', () => {
    logProviderCall({ route: '/v1/kyc/verify', status: 200, durationMs: 123 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.route).toBe('/v1/kyc/verify');
    expect(parsed.status).toBe(200);
    expect(parsed.durationMs).toBe(123);
    expect(parsed.event).toBe('provider.call');
  });

  it('carries one request id across the API and provider boundary', () => {
    withRequestId('req-123', () => {
      expect(getRequestId()).toBe('req-123');
      logger.info('http.request', { route: '/v1/kyc/verify' });
      logProviderCall({ route: '/v1/kyc/verify', status: 200, durationMs: 42 });
    });
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => JSON.parse(l).requestId);
    expect(ids).toEqual(['req-123', 'req-123']);
  });

  it('never logs a NIN, an API key or a connection string', () => {
    // NIN and secrets are synthetic and not real. The point is that the
    // logger redacts them even when a caller passes them in by accident.
    const nin = '12345678901';
    const apiKey = 'sk_live_abcdef01234567890abcdef';
    const connectionString =
      'postgres://user:password@db.internal.example.com:5432/veil';

    logger.error('provider.error', {
      message: `failed for ${nin}`,
      apiKey,
      databaseUrl: connectionString,
    });

    const joined = lines.join('\n');
    expect(joined).not.toContain(nin);
    expect(joined).not.toContain(apiKey);
    expect(joined).not.toContain(connectionString);
    expect(joined).not.toContain('password');
  });

  it('safeDetails only exposes whitelisted keys', () => {
    const details = safeDetails(
      { status: 'success', nin: '12345678901', token: 'sk_live_abcdef01234567890abcdef' },
      ['status'],
    );
    expect(details).toEqual({ status: 'success' });
  });
});
