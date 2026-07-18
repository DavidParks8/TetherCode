import { readAccountLoginStartResponse, readAccountSnapshot } from '../account';

describe('account payload mapping', () => {
  it.each([
    [null, { type: null, email: null, planType: null, requiresOpenaiAuth: false }],
    [{ account: { type: 'apiKey', email: 'ignored@example.com' } }, { type: 'apiKey', email: null, planType: null, requiresOpenaiAuth: false }],
    [{ account: { type: 'unsupported' }, requires_openai_auth: true }, { type: null, email: null, planType: null, requiresOpenaiAuth: true }],
    [{ account: { type: 'chatgpt', email: 42, planType: 'invalid', plan_type: 'team' } }, { type: 'chatgpt', email: null, planType: 'team', requiresOpenaiAuth: false }],
    [{ account: { type: 'chatgpt', planType: 42 } }, { type: 'chatgpt', email: null, planType: null, requiresOpenaiAuth: false }],
  ])('maps account snapshot %# defensively', (payload, expected) => {
    expect(readAccountSnapshot(payload)).toEqual(expected);
  });

  it.each([
    ['apiKey', { type: 'apiKey' }],
    ['chatgptAuthTokens', { type: 'chatgptAuthTokens' }],
  ])('maps the %s login response', (type, expected) => {
    expect(readAccountLoginStartResponse({ type })).toEqual(expected);
  });

  it('maps snake_case optional and required device-code fields', () => {
    expect(readAccountLoginStartResponse({
      type: 'chatgpt',
      loginId: 'login-web',
      authUrl: 'https://example.com/login',
      user_code: 'WEB-CODE',
    })).toEqual({
      type: 'chatgpt',
      loginId: 'login-web',
      authUrl: 'https://example.com/login',
      userCode: 'WEB-CODE',
    });
    expect(readAccountLoginStartResponse({
      type: 'chatgptDeviceCode',
      loginId: 'login-device',
      verification_url: 'https://example.com/device',
      user_code: 'DEVICE-CODE',
    })).toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login-device',
      verificationUrl: 'https://example.com/device',
      userCode: 'DEVICE-CODE',
    });
  });

  it.each([
    [{ type: 'chatgpt', loginId: '', authUrl: 'https://example.com' }, 'incomplete ChatGPT login'],
    [{ type: 'chatgptDeviceCode', loginId: 'id', verificationUrl: '', userCode: 'code' }, 'incomplete ChatGPT device login'],
    [{ type: 'unknown' }, 'unsupported login response'],
    [null, 'unsupported login response'],
  ])('rejects invalid login response %#', (payload, message) => {
    expect(() => readAccountLoginStartResponse(payload)).toThrow(message);
  });
});
