import { toMarkdownImageSource } from '../chatImageSource';

describe('chatImageSource', () => {
  it('keeps remote https images direct', () => {
    expect(
      toMarkdownImageSource(
        'https://example.com/image.png',
        'http://192.168.1.26:8787',
        'secret-token'
      )
    ).toEqual({
      uri: 'https://example.com/image.png',
    });
  });

  it('keeps data uri images direct', () => {
    expect(
      toMarkdownImageSource(
        'data:image/png;base64,abc123',
        'http://192.168.1.26:8787',
        'secret-token'
      )
    ).toEqual({
      uri: 'data:image/png;base64,abc123',
    });
  });

  it('proxies absolute local paths through the bridge', () => {
    expect(
      toMarkdownImageSource('/tmp/My QR.png', 'http://192.168.1.26:8787', 'secret-token')
    ).toEqual({
      uri: 'http://192.168.1.26:8787/local-image?path=%2Ftmp%2FMy%20QR.png',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
  });

  it('proxies file scheme paths through the bridge', () => {
    expect(
      toMarkdownImageSource(
        'file:///Users/mohitpatil/Desktop/bridge.png',
        'http://192.168.1.26:8787',
        null
      )
    ).toEqual({
      uri: 'http://192.168.1.26:8787/local-image?path=%2FUsers%2Fmohitpatil%2FDesktop%2Fbridge.png',
    });
  });

  it('returns null for unsupported relative paths', () => {
    expect(
      toMarkdownImageSource('./relative.png', 'http://192.168.1.26:8787', 'secret-token')
    ).toBeNull();
  });

  it('rejects blank sources and local paths without a bridge URL', () => {
    expect(toMarkdownImageSource('   ', 'http://bridge.test', 'token')).toBeNull();
    expect(toMarkdownImageSource('/tmp/image.png', '   ', 'token')).toBeNull();
    expect(toMarkdownImageSource('file://', 'http://bridge.test', 'token')).toBeNull();
  });

  it('normalizes Windows paths, encoded characters, and bridge slashes', () => {
    expect(
      toMarkdownImageSource(
        'C:\\Users\\me\\My%20Image.png',
        'http://bridge.test/',
        '  '
      )
    ).toEqual({
      uri: 'http://bridge.test/local-image?path=%2FC%3A%2FUsers%2Fme%2FMy%20Image.png',
    });
  });

  it('keeps malformed URI escapes instead of rejecting an otherwise valid path', () => {
    expect(toMarkdownImageSource('/tmp/%E0%A4%A.png', 'http://bridge.test', undefined)).toEqual({
      uri: 'http://bridge.test/local-image?path=%2Ftmp%2F%25E0%25A4%25A.png',
    });
  });

  it.each([
    'http://example.com/image.png',
    'content://images/1',
    'assets-library://asset/1',
    'ph://asset/1',
    'blob:image-id',
  ])('keeps supported remote source %s direct', (source) => {
    expect(toMarkdownImageSource(source, null, null)).toEqual({ uri: source });
  });
});
