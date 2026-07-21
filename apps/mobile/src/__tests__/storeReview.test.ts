import * as StoreReview from 'expo-store-review';
import { Linking, Platform } from 'react-native';
import type * as StoreReviewModule from '../storeReview';

import {
  AUTO_STORE_REVIEW_THRESHOLD_MS,
  createDefaultAutoStoreReviewState,
  isAutoStoreReviewEligible,
  openAppStoreWriteReviewPage,
  parseAutoStoreReviewState,
  requestNativeStoreReview,
} from '../storeReview';

describe('storeReview helpers', () => {
  it('defaults invalid payloads to an unused review state', () => {
    expect(parseAutoStoreReviewState('')).toEqual(createDefaultAutoStoreReviewState());
    expect(parseAutoStoreReviewState('{')).toEqual(createDefaultAutoStoreReviewState());
  });

  it('normalizes persisted review prompt state', () => {
    expect(
      parseAutoStoreReviewState(
        JSON.stringify({
          accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS + 2500.9,
          automaticRequestAt: ' 2026-03-31T12:00:00.000Z ',
        })
      )
    ).toEqual({
      accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS + 2500,
      automaticRequestAt: '2026-03-31T12:00:00.000Z',
    });
  });

  it('rejects invalid accumulated time and request timestamps', () => {
    for (const accumulatedForegroundMs of [-1, 0, Number.POSITIVE_INFINITY, '100']) {
      expect(parseAutoStoreReviewState(JSON.stringify({ accumulatedForegroundMs })))
        .toMatchObject({ accumulatedForegroundMs: 0 });
    }
    expect(parseAutoStoreReviewState(JSON.stringify({ automaticRequestAt: 'not-a-date' })))
      .toMatchObject({ automaticRequestAt: null });
    expect(parseAutoStoreReviewState(JSON.stringify({ automaticRequestAt: 1 })))
      .toMatchObject({ automaticRequestAt: null });
  });

  it('becomes eligible after the active-use threshold until an automatic request is recorded', () => {
    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS - 1,
        automaticRequestAt: null,
      })
    ).toBe(false);

    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS,
        automaticRequestAt: null,
      })
    ).toBe(true);

    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS * 2,
        automaticRequestAt: '2026-03-31T12:00:00.000Z',
      })
    ).toBe(false);
  });

  it('loads, saves, and defaults file state', async () => {
    const read = jest.fn();
    const write = jest.fn().mockResolvedValue(undefined);
    jest.resetModules();
    jest.doMock('expo-file-system/legacy', () => ({
      documentDirectory: 'file:///documents/',
      readAsStringAsync: read,
      writeAsStringAsync: write,
    }));
    let isolated!: typeof StoreReviewModule;
    jest.isolateModules(() => {
      isolated = jest.requireActual('../storeReview') as typeof StoreReviewModule;
    });
    read.mockResolvedValueOnce(JSON.stringify({ accumulatedForegroundMs: 12, automaticRequestAt: null }));
    await expect(isolated.loadAutoStoreReviewState()).resolves.toEqual({
      accumulatedForegroundMs: 12,
      automaticRequestAt: null,
    });
    await isolated.saveAutoStoreReviewState({ accumulatedForegroundMs: 20, automaticRequestAt: null });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('tethercode-store-review.json'),
      JSON.stringify({ accumulatedForegroundMs: 20, automaticRequestAt: null })
    );
    read.mockRejectedValueOnce(new Error('missing'));
    await expect(isolated.loadAutoStoreReviewState()).resolves.toEqual(createDefaultAutoStoreReviewState());
  });

  it('requests native review only when available on iOS', async () => {
    const available = jest.spyOn(StoreReview, 'isAvailableAsync');
    const request = jest.spyOn(StoreReview, 'requestReview').mockResolvedValue(undefined);
    available.mockResolvedValueOnce(false);
    await expect(requestNativeStoreReview()).resolves.toBe(false);
    available.mockResolvedValueOnce(true);
    await expect(requestNativeStoreReview()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await expect(requestNativeStoreReview()).resolves.toBe(false);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
  });

  it('opens the deep link and falls back to the web review URL', async () => {
    const originalAppStoreId = process.env.EXPO_PUBLIC_IOS_APP_STORE_ID;
    process.env.EXPO_PUBLIC_IOS_APP_STORE_ID = '1234567890';
    jest.resetModules();
    const isolated = jest.requireActual<typeof StoreReviewModule>('../storeReview');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await expect(isolated.openAppStoreWriteReviewPage()).resolves.toBe(true);
    expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/^itms-apps:/));
    open.mockRejectedValueOnce(new Error('unsupported')).mockResolvedValueOnce(undefined);
    await expect(isolated.openAppStoreWriteReviewPage()).resolves.toBe(true);
    expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/^https:/));

    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await expect(isolated.openAppStoreWriteReviewPage()).resolves.toBe(false);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    if (originalAppStoreId === undefined) {
      delete process.env.EXPO_PUBLIC_IOS_APP_STORE_ID;
    } else {
      process.env.EXPO_PUBLIC_IOS_APP_STORE_ID = originalAppStoreId;
    }
  });

  it('hides the App Store review link until the fork owns a listing', async () => {
    await expect(openAppStoreWriteReviewPage()).resolves.toBe(false);
  });
});
