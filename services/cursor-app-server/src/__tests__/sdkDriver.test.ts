import { getDefaultSdkStateRoot, type LocalAgentStore } from '@cursor/sdk';

import { buildLocalCursorAgentOptions, localCursorAgentStoreRoot } from '../sdkDriver.js';

describe('CursorSdkDriver', () => {
  const store = {} as LocalAgentStore;

  it('pins new local agents to the requested Cursor SDK workspace', () => {
    const options = buildLocalCursorAgentOptions({ cwd: '/workspace/launchkit', store });

    expect(options.local?.cwd).toBe('/workspace/launchkit');
    expect(options.local?.store).toBe(store);
    expect(localCursorAgentStoreRoot('/workspace/launchkit')).toBe(
      getDefaultSdkStateRoot('/workspace/launchkit')
    );
  });

  it('uses the SDK default SQLite state root for existing workspace stores', () => {
    expect(localCursorAgentStoreRoot('/workspace/clawdex-mobile')).toBe(
      getDefaultSdkStateRoot('/workspace/clawdex-mobile')
    );
  });
});
