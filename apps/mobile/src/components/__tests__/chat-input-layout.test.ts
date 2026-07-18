import { resolveComposerBottomSpacing } from '../chat-input-layout';

describe('resolveComposerBottomSpacing', () => {
  it('keeps a small fixed reserve for iPhones with a home indicator', () => {
    expect(resolveComposerBottomSpacing('ios', 34, false)).toEqual({
      baseBottomPadding: 6,
      extraBottomInset: 8,
      totalBottomPadding: 14,
    });
  });

  it('collapses the bottom reserve while the keyboard is visible on iOS', () => {
    expect(resolveComposerBottomSpacing('ios', 34, true)).toEqual({
      baseBottomPadding: 2,
      extraBottomInset: 0,
      totalBottomPadding: 2,
    });
  });

  it('stays flush on Android when the system reports no bottom inset', () => {
    expect(resolveComposerBottomSpacing('android', 0, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 0,
      totalBottomPadding: 8,
    });
  });

  it('uses the full reported Android bottom inset when nav buttons are visible', () => {
    expect(resolveComposerBottomSpacing('android', 24, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 24,
      totalBottomPadding: 32,
    });
  });

  it('normalizes invalid and negative insets', () => {
    expect(resolveComposerBottomSpacing('android', Number.NaN, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 0,
      totalBottomPadding: 8,
    });
    expect(resolveComposerBottomSpacing('android', -12, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 0,
      totalBottomPadding: 8,
    });
  });

  it('uses compact keyboard spacing on Android and unknown platforms', () => {
    expect(resolveComposerBottomSpacing('android', 24, true)).toEqual({
      baseBottomPadding: 0,
      extraBottomInset: 0,
      totalBottomPadding: 0,
    });
    expect(resolveComposerBottomSpacing('web', 12, true)).toEqual({
      baseBottomPadding: 0,
      extraBottomInset: 0,
      totalBottomPadding: 0,
    });
    expect(resolveComposerBottomSpacing('web', 12, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 12,
      totalBottomPadding: 20,
    });
  });

  it('adds the iOS reserve only at the home-indicator threshold', () => {
    expect(resolveComposerBottomSpacing('ios', 19, false).extraBottomInset).toBe(0);
    expect(resolveComposerBottomSpacing('ios', 20, false).extraBottomInset).toBe(8);
  });
});
