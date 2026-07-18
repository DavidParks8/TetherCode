import {
  applyBrowserPreviewShellMode,
  applyBrowserPreviewViewportPreset,
  buildBrowserPreviewViewportNavigationUrl,
  buildBrowserPreviewBootstrapUrl,
  dedupeRecentPreviewTargets,
  extractLocalPreviewUrls,
  getBrowserPreviewOrigin,
  getNativeBrowserPreviewShellMode,
  getBrowserPreviewShellRequestKey,
  isLocalPreviewCandidateUrl,
  isSameOriginUrl,
  mapBrowserPreviewNavigationUrlToTargetUrl,
  normalizeBrowserPreviewViewportSpec,
  normalizePreviewTargetInput,
  pushRecentPreviewTarget,
} from '../browserPreview';

describe('browserPreview', () => {
  it('normalizes bare ports into loopback preview URLs', () => {
    expect(normalizePreviewTargetInput('3000')).toBe('http://127.0.0.1:3000/');
  });

  it('normalizes localhost inputs without a scheme', () => {
    expect(normalizePreviewTargetInput('localhost:5173')).toBe('http://localhost:5173/');
  });

  it('rejects non-loopback preview targets', () => {
    expect(normalizePreviewTargetInput('https://example.com')).toBeNull();
  });

  it('rejects empty, malformed, unsafe, and non-http preview targets', () => {
    expect(normalizePreviewTargetInput(null as never)).toBeNull();
    expect(normalizePreviewTargetInput('  ')).toBeNull();
    expect(normalizePreviewTargetInput('not a url')).toBeNull();
    expect(normalizePreviewTargetInput('ftp://localhost/file')).toBeNull();
    expect(normalizePreviewTargetInput('http://user:pass@localhost:3000')).toBeNull();
    expect(isLocalPreviewCandidateUrl('https://[::1]:8080/path#fragment')).toBe(true);
    expect(normalizePreviewTargetInput('https://[::1]:8080/path#fragment')).toBe(
      'https://[::1]:8080/path'
    );
  });

  it('extracts local preview URLs from mixed text', () => {
    expect(
      extractLocalPreviewUrls(
        'Server ready on http://localhost:3000 and HMR on http://127.0.0.1:5173/__vite_ping'
      )
    ).toEqual([
      'http://localhost:3000/',
      'http://127.0.0.1:5173/__vite_ping',
    ]);
  });

  it('ignores trailing markdown backticks around preview URLs', () => {
    expect(
      extractLocalPreviewUrls('Open `http://localhost:3000/` in browser')
    ).toEqual(['http://localhost:3000/']);
  });

  it('returns no extracted URLs for empty, non-string, or unmatched text', () => {
    expect(extractLocalPreviewUrls('')).toEqual([]);
    expect(extractLocalPreviewUrls(null as never)).toEqual([]);
    expect(extractLocalPreviewUrls('Server is not listening locally')).toEqual([]);
  });

  it('keeps recent preview targets unique and ordered', () => {
    expect(
      pushRecentPreviewTarget(
        ['http://127.0.0.1:3000/', 'http://localhost:5173/'],
        '127.0.0.1:3000'
      )
    ).toEqual(['http://127.0.0.1:3000/', 'http://localhost:5173/']);
  });

  it('dedupes and trims recent targets', () => {
    expect(
      dedupeRecentPreviewTargets([
        '3000',
        'http://127.0.0.1:3000/',
        'localhost:5173',
      ])
    ).toEqual(['http://127.0.0.1:3000/', 'http://localhost:5173/']);
  });

  it('drops invalid recent targets and caps the list', () => {
    const ports = Array.from({ length: 10 }, (_, index) => String(3000 + index));
    expect(dedupeRecentPreviewTargets(['invalid', ...ports])).toHaveLength(8);
    expect(pushRecentPreviewTarget(ports, 'invalid')).toEqual(
      ports.slice(0, 8).map((port) => `http://127.0.0.1:${port}/`)
    );
  });

  it('normalizes viewport dimensions and defaults invalid presets to mobile', () => {
    expect(normalizeBrowserPreviewViewportSpec(null)).toEqual({ preset: 'mobile' });
    expect(normalizeBrowserPreviewViewportSpec({ preset: 'mobile', width: 1000 })).toEqual({
      preset: 'mobile',
    });
    expect(
      normalizeBrowserPreviewViewportSpec({
        preset: 'desktop',
        width: 100.4,
        height: Number.POSITIVE_INFINITY,
      })
    ).toEqual({ preset: 'desktop', width: undefined, height: undefined });
    expect(
      normalizeBrowserPreviewViewportSpec({ preset: 'desktop', width: 1200.6, height: 5000 })
    ).toEqual({ preset: 'desktop', width: 1201, height: undefined });
  });

  it('builds a preview bootstrap URL from the active bridge host', () => {
    expect(
      buildBrowserPreviewBootstrapUrl(
        'http://192.168.1.26:8787',
        8788,
        '/app?sid=preview&st=token'
      )
    ).toBe('http://192.168.1.26:8788/app?sid=preview&st=token&vp=mobile');
  });

  it('builds a desktop preview bootstrap URL when requested', () => {
    expect(
      buildBrowserPreviewBootstrapUrl(
        'http://192.168.1.26:8787',
        8788,
        '/app?sid=preview&st=token',
        { preset: 'desktop', width: 1440, height: 900 }
      )
    ).toBe(
      'http://192.168.1.26:8788/app?sid=preview&st=token&vp=desktop&vw=1440&vh=900'
    );
  });

  it('uses an explicit preview base URL', () => {
    expect(
      buildBrowserPreviewBootstrapUrl(
        'https://bridge.example.com',
        8788,
        '/app?sid=preview&st=token',
        { preset: 'mobile' },
        'https://preview.example.com'
      )
    ).toBe('https://preview.example.com/app?sid=preview&st=token&vp=mobile');
  });

  it('validates bootstrap inputs and falls back from invalid explicit bases', () => {
    expect(buildBrowserPreviewBootstrapUrl(null as never, 8788, '/app')).toBeNull();
    expect(buildBrowserPreviewBootstrapUrl('http://bridge.test', 8788, null as never)).toBeNull();
    expect(buildBrowserPreviewBootstrapUrl(' ', 8788, '/app')).toBeNull();
    expect(buildBrowserPreviewBootstrapUrl('invalid', 8788, '/app')).toBeNull();
    expect(
      buildBrowserPreviewBootstrapUrl(
        'http://bridge.test:8787/path?old=1#hash',
        8788,
        'app',
        { preset: 'mobile' },
        'ftp://preview.test'
      )
    ).toBe('http://bridge.test:8788/app?vp=mobile');
  });

  it('applies and clears shell modes', () => {
    expect(
      applyBrowserPreviewShellMode('http://preview.test/app?frame=1&shell=desktop', 'overview')
    ).toBe('http://preview.test/app?shell=overview');
    expect(applyBrowserPreviewShellMode('http://preview.test/app?shell=desktop', null)).toBe(
      'http://preview.test/app'
    );
    expect(applyBrowserPreviewShellMode(null as never, null)).toBeNull();
    expect(applyBrowserPreviewShellMode('invalid', 'desktop')).toBeNull();
  });

  it('updates an existing preview URL with a different viewport preset', () => {
    expect(
      applyBrowserPreviewViewportPreset(
        'http://192.168.1.26:8788/dashboard?foo=bar&vp=mobile',
        { preset: 'desktop', width: 1512, height: 982 }
      )
    ).toBe(
      'http://192.168.1.26:8788/dashboard?foo=bar&vp=desktop&vw=1512&vh=982'
    );
  });

  it('clears desktop dimensions for mobile and rejects invalid viewport URLs', () => {
    expect(
      applyBrowserPreviewViewportPreset('http://preview.test/?vp=desktop&vw=800&vh=600', {
        preset: 'mobile',
      })
    ).toBe('http://preview.test/?vp=mobile');
    expect(
      applyBrowserPreviewViewportPreset('http://preview.test/?vw=800&vh=600', {
        preset: 'desktop',
        width: 10,
        height: null,
      })
    ).toBe('http://preview.test/?vp=desktop');
    expect(applyBrowserPreviewViewportPreset(null as never, { preset: 'mobile' })).toBeNull();
    expect(applyBrowserPreviewViewportPreset('invalid', { preset: 'mobile' })).toBeNull();
  });

  it('preserves the current preview path while reapplying bootstrap session params', () => {
    expect(
      buildBrowserPreviewViewportNavigationUrl(
        'http://192.168.1.26:8788/settings/profile?tab=2',
        'http://192.168.1.26:8788/?sid=preview&st=token&vp=mobile',
        { preset: 'desktop', width: 1728, height: 1117 }
      )
    ).toBe(
      'http://192.168.1.26:8788/settings/profile?tab=2&sid=preview&st=token&vp=desktop&vw=1728&vh=1117'
    );
  });

  it('falls back to bootstrap navigation when session context cannot be preserved', () => {
    const bootstrap = 'http://preview.test/?sid=session&st=token&vp=mobile';
    expect(
      buildBrowserPreviewViewportNavigationUrl('http://other.test/path', bootstrap, {
        preset: 'desktop',
      })
    ).toBe('http://preview.test/?sid=session&st=token&vp=desktop');
    expect(
      buildBrowserPreviewViewportNavigationUrl('not a url', bootstrap, { preset: 'mobile' })
    ).toBe(bootstrap);
    expect(
      buildBrowserPreviewViewportNavigationUrl('http://preview.test/path', 'invalid', {
        preset: 'mobile',
      })
    ).toBeNull();
    expect(
      buildBrowserPreviewViewportNavigationUrl(null as never, bootstrap, { preset: 'mobile' })
    ).toBeNull();
  });

  it('builds a stable shell request key from preview bootstrap params', () => {
    expect(
      getBrowserPreviewShellRequestKey(
        'http://192.168.1.26:8788/?sid=preview-session&st=preview-token&vp=desktop&vw=1728&vh=1117&shell=overview'
      )
    ).toBe('preview-session');
  });

  it('returns no shell request key for absent or malformed sessions', () => {
    expect(getBrowserPreviewShellRequestKey(null)).toBeNull();
    expect(getBrowserPreviewShellRequestKey('http://preview.test/')).toBeNull();
    expect(getBrowserPreviewShellRequestKey('invalid')).toBeNull();
  });

  it('resolves preview origins from explicit and bridge-derived bases', () => {
    expect(getBrowserPreviewOrigin('http://bridge.test:8787/path', 8788)).toBe(
      'http://bridge.test:8788'
    );
    expect(getBrowserPreviewOrigin('invalid', 8788, 'https://preview.test/path')).toBe(
      'https://preview.test'
    );
    expect(getBrowserPreviewOrigin('invalid', 8788)).toBeNull();
    expect(isSameOriginUrl('https://preview.test/path', 'https://preview.test')).toBe(true);
    expect(isSameOriginUrl('https://other.test/path', 'https://preview.test')).toBe(false);
    expect(isSameOriginUrl('invalid', 'https://preview.test')).toBe(false);
    expect(isSameOriginUrl('https://preview.test', null)).toBe(false);
  });

  it('maps native desktop presets to the expected shell modes on ios and android', () => {
    expect(getNativeBrowserPreviewShellMode('ios', 'mobile')).toBeNull();
    expect(getNativeBrowserPreviewShellMode('ios', 'desktop')).toBe('overview');
    expect(getNativeBrowserPreviewShellMode('ios', 'desktop2')).toBe('desktop');
    expect(getNativeBrowserPreviewShellMode('android', 'mobile')).toBeNull();
    expect(getNativeBrowserPreviewShellMode('android', 'desktop')).toBe('overview');
    expect(getNativeBrowserPreviewShellMode('android', 'desktop2')).toBe('desktop');
    expect(getNativeBrowserPreviewShellMode('web', 'desktop')).toBeNull();
  });

  it('maps a preview navigation URL back to the original target URL for display', () => {
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'http://100.108.165.85:8788/dashboard?sid=preview&st=token&vp=mobile',
        'http://100.108.165.85:8788',
        'http://127.0.0.1:3000/'
      )
    ).toBe('http://127.0.0.1:3000/dashboard');
  });

  it('maps proxied backend preview navigation URLs back to their loopback origin', () => {
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'http://100.108.165.85:8788/__clawdex_proxy__/aHR0cDovLzEyNy4wLjAuMTozMDAz/api/waitlist?source=landing',
        'http://100.108.165.85:8788',
        'http://127.0.0.1:3000/'
      )
    ).toBe('http://127.0.0.1:3003/api/waitlist?source=landing');
  });

  it('handles external, root proxy, invalid proxy, and malformed navigation URLs', () => {
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'https://external.test/path',
        'http://preview.test',
        'http://127.0.0.1:3000/'
      )
    ).toBe('https://external.test/path');
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'http://preview.test/__clawdex_proxy__/aHR0cDovLzEyNy4wLjAuMTozMDAw?sid=x',
        'http://preview.test',
        'http://127.0.0.1:4000/base'
      )
    ).toBe('http://127.0.0.1:3000/');
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'http://preview.test/__clawdex_proxy__//fallback?frame=1&keep=yes#top',
        'http://preview.test',
        'http://127.0.0.1:4000/base'
      )
    ).toBe('http://127.0.0.1:4000/fallback?keep=yes#top');
    expect(
      mapBrowserPreviewNavigationUrlToTargetUrl(
        'http://preview.test/__clawdex_proxy__/aGVsbG8/bad',
        'http://preview.test',
        'http://127.0.0.1:4000/'
      )
    ).toBeNull();
    expect(mapBrowserPreviewNavigationUrlToTargetUrl(null as never, 'x', 'y')).toBeNull();
    expect(mapBrowserPreviewNavigationUrlToTargetUrl('invalid', 'x', 'y')).toBeNull();
  });
});
