import {
  DEFAULT_FONT_PREFERENCE,
  FONT_PREFERENCE_OPTIONS,
  getFontFamilies,
  getFontPreferenceLabel,
  normalizeFontPreference,
  type FontPreference,
} from '../fonts';

describe('fonts', () => {
  it('accepts every advertised preference and resolves its families and label', () => {
    for (const option of FONT_PREFERENCE_OPTIONS) {
      expect(normalizeFontPreference(option.key)).toBe(option.key);
      expect(getFontFamilies(option.key).monoRegular).toEqual(expect.any(String));
      expect(getFontPreferenceLabel(option.key)).toBe(option.title);
    }
  });

  it('defaults unknown preferences and labels', () => {
    expect(normalizeFontPreference('comicSans')).toBe(DEFAULT_FONT_PREFERENCE);
    expect(normalizeFontPreference(null)).toBe(DEFAULT_FONT_PREFERENCE);
    expect(getFontPreferenceLabel('missing' as FontPreference)).toBe('System');
  });
});
