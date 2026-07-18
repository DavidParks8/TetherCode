import { BrowserPreviewSessionLifecycle } from '../browserPreviewSessionLifecycle';

describe('BrowserPreviewSessionLifecycle', () => {
  it('serializes creates and closes replaced sessions', async () => {
    const closeBrowserPreviewSession = jest.fn().mockResolvedValue(true);
    const lifecycle = new BrowserPreviewSessionLifecycle({ closeBrowserPreviewSession });
    const order: string[] = [];
    let releaseFirst = () => {};

    const first = lifecycle.serializeCreate(
      () =>
        new Promise<string>((resolve) => {
          order.push('first-start');
          releaseFirst = () => resolve('first');
        })
    );
    const second = lifecycle.serializeCreate(async () => {
      order.push('second-start');
      return 'second';
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    lifecycle.adopt(await first);
    lifecycle.adopt(await second);

    expect(order).toEqual(['first-start', 'second-start']);
    expect(closeBrowserPreviewSession).toHaveBeenCalledWith('first');
  });

  it('closes stale, start-page, and post-unmount sessions', async () => {
    const closeBrowserPreviewSession = jest.fn().mockResolvedValue(true);
    const lifecycle = new BrowserPreviewSessionLifecycle({ closeBrowserPreviewSession });

    lifecycle.discard('stale');
    lifecycle.adopt('active');
    lifecycle.clear();
    lifecycle.dispose();
    lifecycle.adopt('late');
    await Promise.resolve();

    expect(closeBrowserPreviewSession.mock.calls.map(([id]) => id)).toEqual([
      'stale',
      'active',
      'late',
    ]);
  });

  it('continues the create queue after rejection and rejects creates after disposal', async () => {
    const lifecycle = new BrowserPreviewSessionLifecycle({
      closeBrowserPreviewSession: jest.fn().mockResolvedValue(true),
    });
    const failure = new Error('create failed');
    const first = lifecycle.serializeCreate(async () => Promise.reject(failure));
    const second = lifecycle.serializeCreate(async () => 'second');

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('second');
    lifecycle.dispose();
    await expect(lifecycle.serializeCreate(async () => 'late')).rejects.toThrow(
      'Preview session lifecycle is disposed'
    );
  });

  it('does not close a session when adopting it twice or clearing an empty lifecycle', () => {
    const closeBrowserPreviewSession = jest.fn().mockRejectedValue(new Error('already closed'));
    const lifecycle = new BrowserPreviewSessionLifecycle({ closeBrowserPreviewSession });

    lifecycle.adopt('same');
    lifecycle.adopt('same');
    lifecycle.discard('same');
    lifecycle.clear();

    expect(closeBrowserPreviewSession).toHaveBeenCalledTimes(1);
    expect(closeBrowserPreviewSession).toHaveBeenCalledWith('same');
  });
});
