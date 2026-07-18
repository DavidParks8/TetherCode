import { readAccountRateLimitSnapshot, readAccountRateLimits } from '../rateLimits';

describe('rate-limit payload mapping', () => {
  it('returns null for non-record and empty snapshots', () => {
    expect(readAccountRateLimits(null)).toBeNull();
    expect(readAccountRateLimitSnapshot('bad')).toBeNull();
    expect(readAccountRateLimitSnapshot({ primary: {}, secondary: null })).toBeNull();
  });

  it('falls through invalid camelCase collections and snapshots to snake_case data', () => {
    expect(readAccountRateLimits({
      rateLimitsByLimitId: {},
      rate_limits_by_limit_id: {
        codex: {
          limit_id: 'codex',
          primary: { used_percent: '12.5', window_duration_mins: '-2.2', resets_at: '9.9' },
          planType: 'invalid',
          plan_type: 'business',
        },
      },
    })).toMatchObject({
      limitId: 'codex',
      planType: 'business',
      primary: { usedPercent: 12.5, windowDurationMins: 0, resetsAt: 9 },
    });

    expect(readAccountRateLimits({
      rateLimits: {},
      rate_limits: { secondary: { used_percent: 33 } },
    })).toMatchObject({ primary: null, secondary: { usedPercent: 33 } });
  });

  it('uses the first valid keyed fallback when the codex bucket is empty', () => {
    expect(readAccountRateLimits({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 'not-a-number' } },
        shared: { primary: { usedPercent: 7 } },
      },
    })?.primary?.usedPercent).toBe(7);
  });

  it.each([
    [{ usedPercent: Number.NaN }, null],
    [{ usedPercent: '' }, null],
    [{ usedPercent: 'Infinity' }, null],
    [{ usedPercent: 0, windowDurationMins: null, resetsAt: undefined }, { usedPercent: 0, windowDurationMins: null, resetsAt: null }],
  ])('maps numeric window values %#', (primary, expected) => {
    expect(readAccountRateLimitSnapshot({ primary })?.primary ?? null).toEqual(expected);
  });

  it.each([
    [null, null],
    [{}, null],
    [{ hasCredits: true, unlimited: false, balance: '4.2' }, { hasCredits: true, unlimited: false, balance: '4.2' }],
    [{ has_credits: false, unlimited: true }, { hasCredits: false, unlimited: true, balance: null }],
    [{ balance: '0' }, { hasCredits: false, unlimited: false, balance: '0' }],
  ])('maps credits %#', (credits, expected) => {
    expect(readAccountRateLimitSnapshot({ primary: { usedPercent: 1 }, credits })?.credits).toEqual(expected);
  });

  it('rejects unknown and non-string plan types', () => {
    expect(readAccountRateLimitSnapshot({ primary: { usedPercent: 1 }, planType: 'invalid' })?.planType).toBeNull();
    expect(readAccountRateLimitSnapshot({ primary: { usedPercent: 1 }, planType: 1 })?.planType).toBeNull();
  });
});
