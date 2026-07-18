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
});
