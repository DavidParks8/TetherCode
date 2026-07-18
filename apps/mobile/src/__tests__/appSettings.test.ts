import {
  DEFAULT_WORKSPACE_CHAT_LIMIT,
  formatWorkspaceChatLimit,
  parseAppSettings,
} from '../appSettings';
import { DEFAULT_FONT_PREFERENCE } from '../fonts';

describe('parseAppSettings', () => {
  it('defaults fresh installs to system appearance', () => {
    expect(parseAppSettings('')).toMatchObject({
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      defaultChatEngine: 'codex',
      approvalMode: 'normal',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
    });
  });

  it('defaults invalid and missing approval modes to normal', () => {
    expect(parseAppSettings('{invalid').approvalMode).toBe('normal');
    expect(parseAppSettings(JSON.stringify({ version: 11 })).approvalMode).toBe('normal');
    expect(
      parseAppSettings(JSON.stringify({ version: 11, approvalMode: 'unexpected' })).approvalMode
    ).toBe('normal');
  });

  it('preserves an explicit YOLO choice from version 11', () => {
    expect(
      parseAppSettings(JSON.stringify({ version: 11, approvalMode: 'yolo' })).approvalMode
    ).toBe('yolo');
  });

  it('defaults showToolCalls to true when unset in stored settings', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 6,
          appearancePreference: 'system',
        })
      ).showToolCalls
    ).toBe(true);
  });

  it('preserves an explicit false showToolCalls preference', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 6,
          showToolCalls: false,
        })
      ).showToolCalls
    ).toBe(false);
  });

  it('migrates version 4 installs to dark appearance when unset', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 4,
        bridgeUrl: 'http://192.168.1.10:9000',
        bridgeToken: 'secret',
        defaultStartCwd: '/tmp/workspace',
        defaultChatEngine: 'codex',
        defaultEngineSettings: {
          codex: { modelId: 'gpt-5.4', effort: 'high' },
          opencode: { modelId: null, effort: null },
        },
        approvalMode: 'normal',
        showToolCalls: true,
      })
    );

    expect(parsed.appearancePreference).toBe('dark');
    expect(parsed.darkUiPalette).toBe('classic');
    expect(parsed.defaultEngineSettings.codex).toEqual({
      modelId: 'gpt-5.4',
      effort: 'high',
    });
  });

  it('preserves stored appearance preferences for version 5 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 5,
        appearancePreference: 'light',
      })
    );

    expect(parsed.appearancePreference).toBe('light');
  });

  it('accepts version 6 settings without bridge credentials', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 6,
        defaultChatEngine: 'opencode',
        appearancePreference: 'system',
      })
    );

    expect(parsed.bridgeUrl).toBeNull();
    expect(parsed.bridgeToken).toBeNull();
    expect(parsed.defaultChatEngine).toBe('opencode');
    expect(parsed.appearancePreference).toBe('system');
  });

  it('preserves a stored font preference for version 8 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 8,
        fontPreference: 'spaceGrotesk',
      })
    );

    expect(parsed.fontPreference).toBe('spaceGrotesk');
  });

  it('preserves darkUiPalette for version 10 settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 10,
        darkUiPalette: 'grey',
      })
    );

    expect(parsed.darkUiPalette).toBe('grey');
  });

  it('loads last-used thread settings for version 11', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 11,
        lastUsedChatEngine: 'cursor',
        lastUsedEngineSettings: {
          cursor: {
            modelId: 'cursor-small',
            effort: 'high',
            serviceTier: 'fast',
            collaborationMode: 'ask',
          },
        },
      })
    );

    expect(parsed.defaultChatEngine).toBe('cursor');
    expect(parsed.defaultEngineSettings.cursor).toEqual({
      modelId: 'cursor-small',
      effort: 'high',
      serviceTier: 'fast',
      collaborationMode: 'ask',
    });
  });

  it('migrates old defaults without treating them as used fast or collaboration settings', () => {
    const parsed = parseAppSettings(
      JSON.stringify({
        version: 10,
        defaultChatEngine: 'opencode',
        defaultEngineSettings: {
          opencode: {
            modelId: 'anthropic/claude',
            effort: 'medium',
            serviceTier: 'fast',
            collaborationMode: 'plan',
          },
        },
      })
    );

    expect(parsed.defaultChatEngine).toBe('opencode');
    expect(parsed.defaultEngineSettings.opencode).toEqual({
      modelId: 'anthropic/claude',
      effort: 'medium',
    });
  });

  it('normalizes the workspace chat limit for version 9 settings', () => {
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 10,
        })
      ).workspaceChatLimit
    ).toBe(10);
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 'all',
        })
      ).workspaceChatLimit
    ).toBeNull();
    expect(
      parseAppSettings(
        JSON.stringify({
          version: 9,
          workspaceChatLimit: 3,
        })
      ).workspaceChatLimit
    ).toBe(DEFAULT_WORKSPACE_CHAT_LIMIT);
  });

  it('accepts every supported settings version and rejects other payloads', () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(parseAppSettings(JSON.stringify({ version })).defaultChatEngine).toBe('codex');
    }
    for (const value of [null, [], { version: 0 }, { version: 13 }, { version: '12' }]) {
      expect(parseAppSettings(JSON.stringify(value)).bridgeUrl).toBeNull();
    }
  });

  it('normalizes credentials, engine fallbacks, and legacy model defaults', () => {
    const parsed = parseAppSettings(JSON.stringify({
      version: 12,
      bridgeUrl: ' ws://example.com:8787/ ',
      bridgeToken: ' secret ',
      defaultStartCwd: ' /workspace ',
      lastUsedChatEngine: 'invalid',
      defaultChatEngine: ' CURSOR ',
      defaultModelId: 'ignored/legacy',
      defaultReasoningEffort: ' XHIGH ',
    }));
    expect(parsed).toMatchObject({
      bridgeUrl: 'http://example.com:8787',
      bridgeToken: 'secret',
      defaultStartCwd: '/workspace',
      defaultChatEngine: 'cursor',
    });
    expect(parsed.defaultEngineSettings.opencode).toEqual({
      modelId: 'ignored/legacy',
      effort: 'xhigh',
    });

    expect(parseAppSettings(JSON.stringify({ version: 3, defaultModelId: 'gpt-4' })))
      .toMatchObject({ defaultChatEngine: 'codex' });
  });

  it('normalizes malformed optional values and remembered settings', () => {
    const parsed = parseAppSettings(JSON.stringify({
      version: 12,
      bridgeUrl: 1,
      bridgeToken: ' ',
      defaultStartCwd: false,
      lastUsedChatEngine: 1,
      defaultEngineSettings: 'invalid',
      lastUsedEngineSettings: {
        codex: null,
        opencode: {
          modelId: ' anthropic/claude ',
          effort: 'NONE',
          serviceTier: ' FAST ',
          collaborationMode: 'plan',
        },
        cursor: {
          modelId: 1,
          effort: 'invalid',
          serviceTier: 'slow',
          collaborationMode: 'ask',
        },
      },
      approvalMode: 'invalid',
      showToolCalls: 'true',
      appearancePreference: 'invalid',
      darkUiPalette: 'invalid',
      fontPreference: 'invalid',
      workspaceChatLimit: ' 25 ',
      recentBrowserTargetUrls: [1, 'localhost:3000', 'localhost:3000'],
    }));
    expect(parsed.defaultEngineSettings.opencode).toEqual({
      modelId: 'anthropic/claude',
      effort: 'none',
      serviceTier: 'fast',
      collaborationMode: 'plan',
    });
    expect(parsed.defaultEngineSettings.cursor).toEqual({
      modelId: null,
      effort: null,
      serviceTier: null,
      collaborationMode: 'ask',
    });
    expect(parsed).toMatchObject({
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      approvalMode: 'normal',
      showToolCalls: false,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: 25,
    });
    expect(parsed.recentBrowserTargetUrls).toHaveLength(1);
  });

  it('supports all workspace limits and display labels', () => {
    expect(parseAppSettings(JSON.stringify({ version: 12, workspaceChatLimit: null })).workspaceChatLimit)
      .toBeNull();
    expect(parseAppSettings(JSON.stringify({ version: 12, workspaceChatLimit: '5' })).workspaceChatLimit)
      .toBe(5);
    expect(parseAppSettings(JSON.stringify({ version: 12, workspaceChatLimit: {} })).workspaceChatLimit)
      .toBe(DEFAULT_WORKSPACE_CHAT_LIMIT);
    expect(formatWorkspaceChatLimit(null)).toBe('All chats');
    expect(formatWorkspaceChatLimit(10)).toBe('10 chats');
  });
});
