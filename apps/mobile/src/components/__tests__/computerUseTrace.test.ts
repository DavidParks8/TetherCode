import {
  computerUseActionIconName,
  isComputerUseTraceEntry,
  parseComputerUseTraceEntry,
} from '../computerUseTrace';

describe('computerUseTrace', () => {
  it('detects computer-use entries across naming variants', () => {
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `computer-use / click`',
      })
    ).toBe(true);
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `computer_use / get_app_state`',
      })
    ).toBe(true);
    expect(
      isComputerUseTraceEntry({
        title: 'Called tool `filesystem / read_file`',
      })
    ).toBe(false);
  });

  it('parses action, app, and window metadata from computer-use traces', () => {
    const parsed = parseComputerUseTraceEntry({
      title: 'Called tool `computer-use / type_text`',
      details: [
        'App=com.google.Chrome (pid 28859)',
        'Window: ".git-debug.txt - clawdex-local", App: Google Chrome.',
        '0 standard window Secondary Actions:',
        'Raise, .git-debug.txt - clawdex-local',
      ],
    });

    expect(parsed).toEqual({
      actionKey: 'typetext',
      actionLabel: 'Typed text',
      appName: 'Google Chrome',
      windowTitle: '.git-debug.txt - clawdex-local',
    });
  });

  it('maps action keys to stable icons', () => {
    expect([
      'getappstate',
      'click',
      'scroll',
      'typetext',
      'presskey',
      'drag',
      'setvalue',
      'listapps',
      'unknownaction',
    ].map(computerUseActionIconName)).toEqual([
      'scan-outline',
      'radio-button-on-outline',
      'swap-vertical-outline',
      'text-outline',
      'keypad-outline',
      'move-outline',
      'create-outline',
      'list-outline',
      'desktop-outline',
    ]);
  });

  it('rejects malformed and non-computer-use tool labels', () => {
    expect(parseComputerUseTraceEntry({ title: 'No tool label', details: [] })).toBeNull();
    expect(parseComputerUseTraceEntry({ title: 'Called tool `   `', details: [] })).toBeNull();
    expect(
      parseComputerUseTraceEntry({ title: 'Called tool `computer-use /   `', details: [] })
    ).toBeNull();
  });

  it.each([
    ['get_app_state', 'Captured screen'],
    ['click', 'Clicked'],
    ['scroll', 'Scrolled'],
    ['press_key', 'Pressed key'],
    ['drag', 'Dragged'],
    ['set_value', 'Set value'],
    ['list_apps', 'Listed apps'],
    ['customAction', 'Custom Action'],
    ['---', 'Computer Use'],
  ])('labels the %s action as %s', (action, expectedLabel) => {
    expect(
      parseComputerUseTraceEntry({
        title: `Called tool \`computer-use / ${action}\``,
        details: [],
      })?.actionLabel
    ).toBe(expectedLabel);
  });

  it('skips blank details and combines metadata without replacing the first window title', () => {
    expect(
      parseComputerUseTraceEntry({
        title: 'Called tool `computer-use / click`',
        details: [
          '   ',
          'Window: "First window"',
          'unrelated output',
          'App=Safari',
          'Window: "Second window", App: com.apple.finder.',
        ],
      })
    ).toEqual({
      actionKey: 'click',
      actionLabel: 'Clicked',
      appName: 'Finder',
      windowTitle: 'First window',
    });
  });

  it('handles empty window metadata and dotted app identifiers', () => {
    expect(
      parseComputerUseTraceEntry({
        title: 'Called tool `computer-use / click`',
        details: ['Window: ""', 'App=com.example.'],
      })
    ).toMatchObject({ appName: 'Example', windowTitle: null });
  });
});
