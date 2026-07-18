import { getChatEngineBadgeColors, getChatEngineLabel, resolveChatEngine } from '../chatEngines';

describe('chatEngines', () => {
  it.each([
    ['codex', 'codex', 'Codex'],
    ['opencode', 'opencode', 'OpenCode'],
    ['cursor', 'cursor', 'Cursor'],
    [null, 'codex', 'Codex'],
    [undefined, 'codex', 'Codex'],
  ] as const)('resolves and labels %s', (input, engine, label) => {
    expect(resolveChatEngine(input)).toBe(engine);
    expect(getChatEngineLabel(input)).toBe(label);
  });

  it.each(['codex', 'opencode', 'cursor'] as const)(
    'provides distinct light and dark colors for %s',
    (engine) => {
      const light = getChatEngineBadgeColors(engine, 'light');
      const dark = getChatEngineBadgeColors(engine, 'dark');
      expect(light).toEqual(expect.objectContaining({
        backgroundColor: expect.any(String),
        borderColor: expect.any(String),
        textColor: expect.any(String),
      }));
      expect(dark).not.toEqual(light);
    }
  );

  it('defaults missing engine and mode values', () => {
    expect(getChatEngineBadgeColors(undefined)).toEqual(getChatEngineBadgeColors('codex', 'dark'));
  });
});
