import { isInsecureRemoteUrl, normalizeBridgeUrlInput, toBridgeHealthUrl } from '../bridgeUrl';

describe('bridgeUrl', () => {
  it('normalizes supported bridge schemes and strips non-base URL parts', () => {
    expect(normalizeBridgeUrlInput(' ws://example.com:8787/rpc///?token=x#hash ')).toBe(
      'http://example.com:8787/rpc'
    );
    expect(normalizeBridgeUrlInput('wss://example.com/')).toBe('https://example.com');
    expect(normalizeBridgeUrlInput('https://example.com/base/')).toBe('https://example.com/base');
  });

  it('rejects malformed, unsupported, credentialed, and empty URLs', () => {
    expect(normalizeBridgeUrlInput(null as unknown as string)).toBeNull();
    expect(normalizeBridgeUrlInput('   ')).toBeNull();
    expect(normalizeBridgeUrlInput('not a url')).toBeNull();
    expect(normalizeBridgeUrlInput('ftp://example.com')).toBeNull();
    expect(normalizeBridgeUrlInput('http://user:pass@example.com')).toBeNull();
  });

  it.each([
    'http://localhost:8787',
    'http://127.0.0.1',
    'http://host.local',
    'http://[::1]',
    'http://[fd00::1]',
    'http://[fc00::1]',
    'http://[fe80::1]',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1',
    'http://169.254.1.1',
    'http://100.64.0.1',
    'http://100.127.255.255',
  ])('allows private HTTP host %s', (url) => {
    expect(isInsecureRemoteUrl(url)).toBe(false);
  });

  it.each([
    'http://example.com',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://100.63.0.1',
    'http://100.128.0.1',
    'http://10.foo.bar.baz',
    'http://10.0.foo.bar',
  ])('flags public or malformed HTTP host %s', (url) => {
    expect(isInsecureRemoteUrl(url)).toBe(true);
  });

  it('does not flag secure or invalid URLs', () => {
    expect(isInsecureRemoteUrl('https://example.com')).toBe(false);
    expect(isInsecureRemoteUrl('invalid')).toBe(false);
  });

  it('builds a health endpoint with exactly one separator', () => {
    expect(toBridgeHealthUrl('http://localhost:8787/')).toBe('http://localhost:8787/health');
    expect(toBridgeHealthUrl('http://localhost:8787')).toBe('http://localhost:8787/health');
  });
});
