import {
  isGeneratedCursorThreadTitle,
  mapChat,
  mapChatSummary,
  readString,
  toPreview,
  toRawThread,
  toRecord,
} from '../chatMapping';

describe('chatMapping', () => {
  it('falls back to createdAt for missing updatedAt instead of using the current time', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_created_only',
        preview: 'created only',
        createdAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      })
    );

    expect(chat.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(chat.updatedAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('maps failed turn error details into lastError', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_failed',
        preview: 'failed',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'error',
            error: {
              message: 'model quota exceeded',
            },
          },
        ],
      })
    );

    expect(chat.status).toBe('error');
    expect(chat.lastError).toBe('model quota exceeded');
  });

  it('maps top-level failed turn detail fields into lastError', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_failed_detail',
        preview: 'failed',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'failed',
            detail: {
              reason: 'app-server stream closed unexpectedly',
            },
          },
        ],
      })
    );

    expect(chat.status).toBe('error');
    expect(chat.lastError).toBe('app-server stream closed unexpectedly');
  });

  it('keeps a generic failed-turn fallback when no error detail is reported', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_failed_generic',
        preview: 'failed',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'aborted',
          },
        ],
      })
    );

    expect(chat.status).toBe('error');
    expect(chat.lastError).toBe('turn aborted');
  });

  it('maps cancelled turn status to an error state', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_cancelled',
        preview: 'cancelled',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'cancelled',
          },
        ],
      })
    );

    expect(chat.status).toBe('error');
    expect(chat.lastError).toBe('turn cancelled');
  });

  it('maps command execution items into system trace messages', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_cmd',
        preview: 'done',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'show status' }],
              },
              {
                type: 'commandExecution',
                id: 'cmd1',
                command: 'git status --short',
                status: 'completed',
                aggregatedOutput: ' M apps/mobile/src/api/ws.ts\n M apps/mobile/src/screens/MainScreen.tsx',
                exitCode: 0,
              },
              {
                type: 'agentMessage',
                id: 'a1',
                text: 'Done',
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[1].role).toBe('system');
    expect(chat.messages[1].systemKind).toBe('tool');
    expect(chat.messages[1].content).toContain('• Ran `git status --short`');
    expect(chat.messages[1].content).toContain('M apps/mobile/src/api/ws.ts');
    expect(chat.messages[2].role).toBe('assistant');
    expect(chat.messages[2].content).toBe('Done');
  });

  it('maps plan and tool items into readable system timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_tools',
        preview: 'tools',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'plan',
                id: 'plan1',
                text: '• Explored\n  └ Read MainScreen.tsx',
              },
              {
                type: 'webSearch',
                id: 'search1',
                query: 'react native keyboard inset',
              },
              {
                type: 'mcpToolCall',
                id: 'tool1',
                server: 'filesystem',
                tool: 'read_file',
                status: 'completed',
                result: { ok: true },
              },
              {
                type: 'fileChange',
                id: 'patch1',
                status: 'completed',
                changes: [{ path: 'apps/mobile/src/screens/MainScreen.tsx' }],
              },
            ],
          },
        ],
      })
    );

    const systemMessages = chat.messages.filter((message) => message.role === 'system');
    expect(systemMessages).toHaveLength(4);
    expect(systemMessages.every((message) => message.systemKind === 'tool')).toBe(true);
    expect(systemMessages[0].content).toContain('• Explored');
    expect(systemMessages[1].content).toContain('• Searched web for "react native keyboard inset"');
    expect(systemMessages[2].content).toContain('• Called tool `filesystem / read_file`');
    expect(systemMessages[3].content).toContain('• Applied file changes to MainScreen.tsx');
    expect(systemMessages[3].content).toContain('apps/mobile/src/screens/MainScreen.tsx');
  });

  it('maps generic Cursor tool calls into visible tool timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_cursor_tool',
        engine: 'cursor',
        preview: 'tools',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'Inspect package' }],
              },
              {
                type: 'toolCall',
                id: 'cursor_tool_read',
                tool: 'read',
                status: 'completed',
                args: { path: '/repo/package.json' },
                result: {
                  status: 'success',
                  value: {
                    content: '{ "name": "clawdex-mobile" }',
                  },
                },
              },
              {
                type: 'agentMessage',
                id: 'a1',
                text: 'The package is clawdex-mobile.',
              },
            ],
          },
        ],
      })
    );

    const systemMessages = chat.messages.filter((message) => message.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].systemKind).toBe('tool');
    expect(systemMessages[0].content).toContain('• Called tool `read`');
    expect(systemMessages[0].content).toContain('Input: /repo/package.json');
    expect(systemMessages[0].content).toContain('clawdex-mobile');
  });

  it('maps Codex function call items into visible tool timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_function_call',
        preview: 'read files',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'function_call',
                id: 'call_read_file',
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: "sed -n '1,80p' apps/mobile/src/api/chatMapping.ts",
                  workdir: '/repo',
                }),
                call_id: 'call_read_file',
              },
              {
                type: 'function_call_output',
                id: 'out_read_file',
                call_id: 'call_read_file',
                output: 'Chunk ID: abc\nOutput:\nimport type { Chat } from ./types;',
              },
              {
                type: 'custom_tool_call_output',
                id: 'custom_out_read_file',
                call_id: 'custom_call_read_file',
                output: 'custom output',
              },
              {
                type: 'agentMessage',
                id: 'a1',
                text: 'I read the mapper.',
              },
            ],
          },
        ],
      })
    );

    const systemMessages = chat.messages.filter((message) => message.role === 'system');
    expect(systemMessages).toHaveLength(3);
    expect(systemMessages.every((message) => message.systemKind === 'tool')).toBe(true);
    expect(systemMessages[0].content).toContain(
      "• Ran `sed -n '1,80p' apps/mobile/src/api/chatMapping.ts`"
    );
    expect(systemMessages[0].content).toContain('cwd: /repo');
    expect(systemMessages[1].content).toContain('• Tool output `call_read_file`');
    expect(systemMessages[1].content).toContain('import type { Chat }');
    expect(systemMessages[2].content).toContain('• Tool output `custom_call_read_file`');
    expect(systemMessages[2].content).toContain('custom output');
  });

  it('maps Codex MCP and search function calls into readable timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_function_call_specialized',
        preview: 'search docs',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'function_call',
                id: 'call_mcp',
                name: 'mcp__computer_use__click',
                arguments: JSON.stringify({ app: 'Simulator', x: 10, y: 20 }),
              },
              {
                type: 'function_call',
                id: 'call_search',
                name: 'search_query',
                arguments: JSON.stringify({
                  search_query: [{ q: 'React Native FlatList maintainVisibleContentPosition' }],
                }),
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0].content).toContain('• Called tool `computer_use / click`');
    expect(chat.messages[0].content).toContain('Input:');
    expect(chat.messages[1].content).toContain(
      '• Searched web for "React Native FlatList maintainVisibleContentPosition"'
    );
  });

  it('maps custom apply_patch calls into file change timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_custom_tool',
        preview: 'patch',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'custom_tool_call',
                id: 'patch_call',
                name: 'apply_patch',
                input: [
                  '*** Begin Patch',
                  '*** Update File: apps/mobile/src/screens/MainScreen.tsx',
                  '@@',
                  '-old',
                  '+new',
                  '*** End Patch',
                ].join('\n'),
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('tool');
    expect(chat.messages[0].content).toContain(
      '• Applied file changes to MainScreen.tsx'
    );
    expect(chat.messages[0].content).toContain('apps/mobile/src/screens/MainScreen.tsx');
  });

  it('includes apply_patch move destinations in file change timeline entries', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_patch_move',
        preview: 'move',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'custom_tool_call',
                id: 'patch_move_call',
                name: 'apply_patch',
                input: [
                  '*** Begin Patch',
                  '*** Update File: apps/mobile/src/screens/OldName.tsx',
                  '*** Move to: apps/mobile/src/screens/NewName.tsx',
                  '@@',
                  '-old',
                  '+new',
                  '*** End Patch',
                ].join('\n'),
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages[0].content).toContain('OldName.tsx +1 more');
    expect(chat.messages[0].content).toContain('apps/mobile/src/screens/OldName.tsx');
    expect(chat.messages[0].content).toContain('apps/mobile/src/screens/NewName.tsx');
  });

  it('uses Cursor summary preview instead of generated Cursor chat names', () => {
    const chat = mapChat(
      toRawThread({
        id: 'cursor:a7f3b2c1',
        engine: 'cursor',
        name: 'Chat cursor:a7f3b2c1',
        title: 'Chat cursor:a7f3b2c1',
        preview: 'Analyzed the Clawdex mobile bridge.',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [],
      })
    );

    expect(chat.title).toBe('Analyzed the Clawdex mobile bridge.');
    expect(chat.lastMessagePreview).toBe('Analyzed the Clawdex mobile bridge.');
  });

  it('maps reasoning items into visible transcript system messages', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_reasoning',
        preview: 'thinking',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'reasoning',
                id: 'reasoning1',
                text: 'Inspecting the current workspace before making changes.',
              },
              {
                type: 'agentMessage',
                id: 'assistant1',
                text: 'I found the issue.',
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('reasoning');
    expect(chat.messages[0].content).toContain('• Reasoning');
    expect(chat.messages[0].content).toContain('Inspecting the current workspace');
    expect(chat.messages[1].role).toBe('assistant');
  });

  it('maps context compaction into a dedicated system message kind', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_compaction',
        preview: 'compacted',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'contextCompaction',
                id: 'compact1',
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('compaction');
    expect(chat.messages[0].content).toContain('Compacted conversation context');
  });

  it('maps Codex reasoning items that use content arrays', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_codex_reasoning',
        preview: 'thinking',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'reasoning',
                id: 'reasoning_codex_1',
                summary: ['Inspecting workspace'],
                content: [
                  'Checking how the bridge forwards live events.',
                  'Comparing persisted thread items with live deltas.',
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('reasoning');
    expect(chat.messages[0].content).toContain('Checking how the bridge forwards live events.');
    expect(chat.messages[0].content).toContain('Comparing persisted thread items with live deltas.');
  });

  it('maps structured reasoning summary text into visible transcript details', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_reasoning_summary',
        preview: 'thinking',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'reasoning',
                id: 'reasoning_summary',
                summary: [
                  {
                    type: 'summary_text',
                    text: 'Read the transcript mapper and checked tool item shapes.',
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('reasoning');
    expect(chat.messages[0].content).toContain('• Reasoning');
    expect(chat.messages[0].content).toContain(
      'Read the transcript mapper and checked tool item shapes.'
    );
  });

  it('maps assistant structured content arrays including images', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_assistant_image',
        preview: 'image',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'agentMessage',
                id: 'assistant_image_1',
                content: [
                  { type: 'text', text: 'Here is the QR code' },
                  { type: 'localImage', path: '/tmp/bridge-pairing-qr.png' },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('assistant');
    expect(chat.messages[0].content).toContain('Here is the QR code');
    expect(chat.messages[0].content).toContain('[local image: /tmp/bridge-pairing-qr.png]');
  });

  it('maps assistant structured content arrays using responses api item types', () => {
    const dataUrl = 'data:image/png;base64,abc123';
    const chat = mapChat(
      toRawThread({
        id: 'thr_assistant_input_image',
        preview: 'image',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'agentMessage',
                id: 'assistant_image_2',
                content: [
                  { type: 'output_text', text: 'Window snapshot attached' },
                  { type: 'input_image', image_url: dataUrl },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('assistant');
    expect(chat.messages[0].content).toContain('Window snapshot attached');
    expect(chat.messages[0].content).toContain(`[image: ${dataUrl}]`);
  });

  it('extracts the latest structured persisted plan for workflow rehydration', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_plan',
        preview: 'plan',
        createdAt: 1700000000,
        updatedAt: 1700000005,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_plan',
            status: 'completed',
            items: [
              {
                type: 'plan',
                id: 'plan_structured',
                explanation: 'Tighten the workflow-card state handling.',
                plan: [
                  {
                    step: 'Extract the workflow card state into a helper',
                    status: 'completed',
                  },
                  {
                    step: 'Render approval inline in the top card',
                    status: 'inProgress',
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.latestPlan).toEqual({
      threadId: 'thr_plan',
      turnId: 'turn_plan',
      explanation: 'Tighten the workflow-card state handling.',
      steps: [
        {
          step: 'Extract the workflow card state into a helper',
          status: 'completed',
        },
        {
          step: 'Render approval inline in the top card',
          status: 'inProgress',
        },
      ],
    });
    expect(chat.latestTurnPlan).toEqual(chat.latestPlan);
    expect(chat.latestTurnStatus).toBe('completed');
  });

  it('derives workflow plan state from persisted plan text when structured fields are absent', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_plan_text',
        preview: 'plan text',
        createdAt: 1700000000,
        updatedAt: 1700000005,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_plan_text',
            status: 'completed',
            items: [
              {
                type: 'plan',
                id: 'plan_text',
                text: [
                  'Workflow Card Cleanup Plan',
                  'Summary',
                  'Tighten the workflow-card transitions without broad MainScreen churn.',
                  '1. Extract the card state resolver',
                  '2. Rehydrate the card from persisted plan data',
                ].join('\n'),
              },
            ],
          },
        ],
      })
    );

    expect(chat.latestPlan).toEqual({
      threadId: 'thr_plan_text',
      turnId: 'turn_plan_text',
      explanation:
        'Tighten the workflow-card transitions without broad MainScreen churn.',
      steps: [
        {
          step: 'Extract the card state resolver',
          status: 'pending',
        },
        {
          step: 'Rehydrate the card from persisted plan data',
          status: 'pending',
        },
      ],
    });
    expect(chat.latestTurnPlan).toEqual(chat.latestPlan);
    expect(chat.latestTurnStatus).toBe('completed');
  });

  it('keeps the latest structured plan even after later non-plan turns', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_plan_history',
        preview: 'history',
        createdAt: 1700000000,
        updatedAt: 1700000006,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_plan',
            status: 'completed',
            items: [
              {
                type: 'plan',
                id: 'plan_history',
                explanation: 'Review the workflow-card UX before coding.',
                plan: [
                  {
                    step: 'Audit the top-card state transitions',
                    status: 'completed',
                  },
                ],
              },
            ],
          },
          {
            id: 'turn_execution',
            status: 'completed',
            items: [
              {
                type: 'agentMessage',
                id: 'assistant_1',
                text: 'Implemented the change.',
              },
            ],
          },
        ],
      })
    );

    expect(chat.latestPlan).toEqual({
      threadId: 'thr_plan_history',
      turnId: 'turn_plan',
      explanation: 'Review the workflow-card UX before coding.',
      steps: [
        {
          step: 'Audit the top-card state transitions',
          status: 'completed',
        },
      ],
    });
    expect(chat.latestTurnPlan).toBeNull();
    expect(chat.latestTurnStatus).toBe('completed');
  });

  it('maps sub-agent source metadata and collaboration items', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_sub',
        preview: 'worker',
        agentNickname: 'Atlas',
        agentRole: 'explorer',
        createdAt: 1700000000,
        updatedAt: 1700000004,
        status: { type: 'idle' },
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'thr_root',
              depth: 1,
            },
          },
        },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'collabToolCall',
                id: 'collab1',
                tool: 'spawn_agent',
                status: 'completed',
                prompt: 'Inspect the websocket protocol and summarize it',
                receiver_thread_ids: ['thr_sub'],
                sender_thread_id: 'thr_root',
                agentStatus: 'running',
              },
            ],
          },
        ],
      })
    );

    expect(chat.sourceKind).toBe('subAgentThreadSpawn');
    expect(chat.parentThreadId).toBe('thr_root');
    expect(chat.subAgentDepth).toBe(1);
    expect(chat.agentNickname).toBe('Atlas');
    expect(chat.agentRole).toBe('explorer');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('subAgent');
    expect(chat.messages[0].content).toContain('• Spawned sub-agent');
    expect(chat.messages[0].content).toContain('Prompt: Inspect the websocket protocol');
    expect(chat.messages[0].content).toContain('Thread: thr_sub');
    expect(chat.messages[0].subAgentMeta).toEqual({
      tool: 'spawn_agent',
      prompt: 'Inspect the websocket protocol and summarize it',
      senderThreadId: 'thr_root',
      receiverThreadIds: ['thr_sub'],
      agentStatus: 'running',
    });
  });

  it('maps user mention attachments into readable file markers', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_mentions',
        preview: 'files',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'u_mentions',
                content: [
                  { type: 'text', text: 'please review these files' },
                  { type: 'mention', path: 'apps/mobile/src/screens/MainScreen.tsx' },
                  { type: 'mention', path: 'apps/mobile/src/api/client.ts' },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[0].content).toContain('please review these files');
    expect(chat.messages[0].content).toContain('[file: apps/mobile/src/screens/MainScreen.tsx]');
    expect(chat.messages[0].content).toContain('[file: apps/mobile/src/api/client.ts]');
  });

  it('maps structured tool results with screenshots into previewable system details', () => {
    const dataUrl = 'data:image/png;base64,toolshot123';
    const chat = mapChat(
      toRawThread({
        id: 'thr_tool_image',
        preview: 'tool image',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'mcpToolCall',
                id: 'tool_image_1',
                server: 'computer_use',
                tool: 'get_app_state',
                status: 'completed',
                result: {
                  content: [
                    {
                      type: 'input_text',
                      text: 'Computer Use state\nApp=com.apple.finder',
                    },
                    {
                      type: 'input_image',
                      image_url: dataUrl,
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('tool');
    expect(chat.messages[0].content).toContain('• Called tool `computer_use / get_app_state`');
    expect(chat.messages[0].content).toContain('Computer Use state');
    expect(chat.messages[0].content).toContain(`[image: ${dataUrl}]`);
  });

  it('maps mcp tool result structuredContent screenshots into previewable system details', () => {
    const dataUrl = 'data:image/png;base64,structuredtoolshot456';
    const chat = mapChat(
      toRawThread({
        id: 'thr_tool_structured_image',
        preview: 'tool structured image',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'mcpToolCall',
                id: 'tool_structured_image_1',
                server: 'computer-use',
                tool: 'get_app_state',
                status: 'completed',
                result: {
                  structuredContent: {
                    content: [
                      {
                        type: 'input_text',
                        text: 'Computer Use state\nApp=Google Chrome',
                      },
                      {
                        type: 'input_image',
                        image_url: dataUrl,
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('tool');
    expect(chat.messages[0].content).toContain('• Called tool `computer-use / get_app_state`');
    expect(chat.messages[0].content).toContain('Computer Use state');
    expect(chat.messages[0].content).toContain(`[image: ${dataUrl}]`);
  });

  it('maps raw image data parts in tool results into previewable screenshots', () => {
    const base64Image = 'rawtoolshot789';
    const chat = mapChat(
      toRawThread({
        id: 'thr_tool_raw_image',
        preview: 'tool raw image',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'mcpToolCall',
                id: 'tool_raw_image_1',
                server: 'computer-use',
                tool: 'get_app_state',
                status: 'completed',
                result: {
                  content: [
                    {
                      type: 'text',
                      text: 'Computer Use state\nApp=Google Chrome',
                    },
                    {
                      type: 'image',
                      data: base64Image,
                      mimeType: 'image/png',
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('tool');
    expect(chat.messages[0].content).toContain('• Called tool `computer-use / get_app_state`');
    expect(chat.messages[0].content).toContain('Computer Use state');
    expect(chat.messages[0].content).toContain(
      `[image: data:image/png;base64,${base64Image}]`
    );
  });

  it('keeps imageview as a compact tool event with the viewed filename', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_imageview',
        preview: 'image',
        createdAt: 1700000000,
        updatedAt: 1700000003,
        status: { type: 'idle' },
        turns: [
          {
            status: 'completed',
            items: [
              {
                type: 'imageview',
                id: 'img_view_1',
                path: '/tmp/bridge-pairing-qr.png',
              },
            ],
          },
        ],
      })
    );

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe('system');
    expect(chat.messages[0].systemKind).toBe('tool');
    expect(chat.messages[0].content).toContain('• Viewed image bridge-pairing-qr.png');
    expect(chat.messages[0].content).toContain('/tmp/bridge-pairing-qr.png');
  });

  it('covers primitive readers, preview truncation, and malformed raw payloads', () => {
    expect(toRecord(null)).toBeNull();
    expect(toRecord('value')).toBeNull();
    expect(toRecord([])).toEqual([]);
    expect(readString(1)).toBeNull();
    expect(readString('value')).toBe('value');
    expect(toPreview('  short\n preview ')).toBe('short preview');
    expect(toPreview('x'.repeat(181))).toBe(`${'x'.repeat(177)}...`);
    expect(toRawThread(null)).toEqual(expect.objectContaining({ id: undefined, turns: undefined }));
    expect(toRawThread({
      thread_name: 'snake title',
      createdAt: ' 12 ',
      updatedAt: 'bad',
      agent_nickname: 'Atlas',
      agent_role: 'worker',
      turns: [null, 'bad', { id: 1, status: 2, items: [null, 'bad', { type: 'agentMessage' }] }],
    })).toEqual(expect.objectContaining({
      name: 'snake title',
      createdAt: 12,
      updatedAt: undefined,
      agentNickname: 'Atlas',
      agentRole: 'worker',
      turns: [expect.objectContaining({ items: [{ type: 'agentMessage' }] })],
    }));
    expect(mapChatSummary({})).toBeNull();
    expect(() => mapChat({})).toThrow('chat id missing');
  });

  it.each([
    ['running turn', { type: 'active' }, 'RUNNING', 'running'],
    ['queued thread', { type: 'queued' }, undefined, 'running'],
    ['failed thread', 'system-error', undefined, 'error'],
    ['successful turn', undefined, 'SUCCEEDED', 'complete'],
    ['active empty thread', 'active', undefined, 'idle'],
    ['active historical thread', 'active', 'unknown', 'complete'],
    ['not-loaded historical thread', 'not_loaded', 'unknown', 'complete'],
    ['unknown thread', '???', undefined, 'idle'],
  ])('maps %s lifecycle state', (_label, status, turnStatus, expected) => {
    const turns = turnStatus === undefined ? [] : [{ status: turnStatus, items: [] }];
    expect(mapChat(toRawThread({ id: 'thr_status', status, turns })).status).toBe(expected);
  });

  it.each([
    [null, null, undefined, true],
    ['A real title', 'cursor:id', 'codex', false],
    ['New Agent', 'cursor:id', 'cursor', true],
    ['Untitled Agent', 'cursor:id', 'cursor', true],
    ['Cursor abcdef12', 'cursor:abcdef123456', 'cursor', true],
    ['Cursor cursor:abcdef123456', 'cursor:abcdef123456', 'cursor', true],
    ['Cursor abcdef123456', 'cursor:abcdef123456', 'cursor', true],
    ['Chat cursor:abcdef123456', 'cursor:abcdef123456', 'cursor', true],
    ['Cursor agent-abcd', 'other', 'codex', true],
  ])('classifies generated title %#', (title, id, engine, expected) => {
    expect(isGeneratedCursorThreadTitle(title, id, engine)).toBe(expected);
  });

  it.each([
    ['string source', 'cli', { sourceKind: 'cli' }],
    ['legacy source', { kind: 'subAgent', parent_thread_id: 'root', agent_depth: '2' }, { sourceKind: 'subAgent', parentThreadId: 'root', subAgentDepth: 2 }],
    ['review source', { subAgent: 'review' }, { sourceKind: 'subAgentReview' }],
    ['compact source', { subagent: 'compact' }, { sourceKind: 'subAgentCompact' }],
    ['memory source', { subAgent: 'memory_consolidation' }, { sourceKind: 'subAgentOther' }],
    ['other string source', { subAgent: 'worker' }, { sourceKind: 'subAgent' }],
    ['invalid tagged source', { subAgent: 3 }, { sourceKind: 'subAgent' }],
    ['other object source', { subAgent: { other: 'memory' } }, { sourceKind: 'subAgentOther' }],
    ['object source', { subAgent: { parentThreadId: 'root', agentDepth: 3 } }, { sourceKind: 'subAgent', parentThreadId: 'root', subAgentDepth: 3 }],
    ['typed source', { type: 'subAgentReview', parentThreadId: 'root', depth: 4 }, { sourceKind: 'subAgentReview', parentThreadId: 'root', subAgentDepth: 4 }],
    ['unknown source', { type: 'cli' }, { sourceKind: undefined }],
  ])('maps %s metadata', (_label, source, expected) => {
    expect(mapChat(toRawThread({ id: 'thr_source', source, turns: [] }))).toEqual(expect.objectContaining(expected));
  });

  it('maps tool failure, running, fallback, and no-detail variants', () => {
    const chat = mapChat(toRawThread({
      id: 'thr_tool_matrix',
      turns: [{
        status: 'completed',
        items: [
          { type: 'commandExecution', command: '', status: 'failed', exit_code: '2' },
          { type: 'mcpToolCall', status: 'error', error: { message: 'mcp failed' } },
          { type: 'mcpToolCall', server: 'srv', tool: 'read', status: 'failed', error: 'plain failure' },
          { type: 'toolCall', name: 'reader', status: 'running', args: 'input', result: { status: 'error', error: { message: 'cursor failed' } } },
          { type: 'toolCall', tool: 'git', status: 'failed', args: { file_path: 'a.ts' }, result: { branches: [null, { branch: 'main', pr_url: 'pr', repo_url: 'repo' }] } },
          { type: 'function_call', name: 'functions.exec_command', status: 'running', args: { command: ['npm', '', 'test'] } },
          { type: 'function_call', name: 'mcp__srv__tool__part', status: 'failed', args: { value: 1 } },
          { type: 'function_call', name: 'generic', status: 'running', arguments: '{bad json' },
          { type: 'function_call_output', output: { ok: true } },
          { type: 'function_call_output', output: null },
          { type: 'fileChange', status: 'failed', changes: ['a\\b.ts', { filePath: 'a/b.ts' }, { file_path: 'c.ts' }, {}, ''] },
          { type: 'imageView', path: '' },
          { type: 'enteredReviewMode' },
          { type: 'exitedReviewMode' },
          { type: 'unknown' },
          {},
        ],
      }],
    }));

    const text = chat.messages.map((message) => message.content).join('\n');
    expect(text).toContain('Command failed `command`');
    expect(text).toContain('exit code 2');
    expect(text).toContain('Tool failed `MCP tool call`');
    expect(text).toContain('cursor failed');
    expect(text).toContain('Branch: main');
    expect(text).toContain('Running command `npm test`');
    expect(text).toContain('Tool failed `srv / tool__part`');
    expect(text).toContain('Calling tool `generic`');
    expect(text).toContain('File changes failed to b.ts +1 more');
    expect(text).toContain('Entered review mode');
    expect(text).toContain('Exited review mode');
  });

  it.each([
    ['spawn failure', 'spawn_agent', 'failed', 'Sub-agent spawn failed'],
    ['spawn pending', 'spawn_agent', 'running', 'Spawning sub-agent'],
    ['send failure', 'send_input', 'error', 'Sub-agent update failed'],
    ['send success', 'send_input', 'complete', 'Sent follow-up'],
    ['wait failure', 'wait', 'failed', 'Waiting on sub-agent failed'],
    ['wait success', 'wait', 'complete', 'Waiting on sub-agent'],
    ['close failure', 'close_agent', 'failed', 'Closing sub-agent failed'],
    ['close success', 'close_agent', 'complete', 'Closed sub-agent'],
    ['other failure', 'other', 'failed', 'Sub-agent action failed'],
    ['other success', 'other', 'complete', 'Updated sub-agent'],
  ])('maps %s collaboration event', (_label, tool, status, expected) => {
    const chat = mapChat(toRawThread({
      id: 'thr_collab_matrix',
      turns: [{ items: [{ type: 'collabToolCall', tool, status }] }],
    }));
    expect(chat.messages[0].content).toContain(expected);
    expect(chat.messages[0].subAgentMeta).toEqual(expect.objectContaining({ tool }));
  });

  it('maps web actions and file changes with empty and multiple targets', () => {
    const chat = mapChat(toRawThread({
      id: 'thr_web_files',
      turns: [{ items: [
        { type: 'webSearch', action: { type: 'open_page', url: 'https://example.com' } },
        { type: 'webSearch', query: 'needle', action: { type: 'find_in_page', url: 'https://example.com', pattern: 'target' } },
        { type: 'fileChange', changes: [] },
        { type: 'fileChange', changes: [{ path: 'one.ts' }, { path: 'two.ts' }] },
      ] }],
    }));
    expect(chat.messages.map((message) => message.content).join('\n')).toContain('https://example.com | pattern: target');
    expect(chat.messages.map((message) => message.content).join('\n')).toContain('one.ts +1 more');
  });

  it('rejects malformed plans and maps alternate steps and statuses', () => {
    const chat = mapChat(toRawThread({
      id: 'thr_plan_edges',
      turns: [
        { id: 'running', status: 'pending', items: [
          null,
          { type: 'plan' },
          { type: 'plan', turn_id: 'alternate', steps: [null, {}, { step: 'Do it', status: 'complete' }, { step: 'Wait', status: 'pending' }] },
        ] },
        { id: 'latest', status: 'completed', items: [{ type: 'plan', id: 'text-plan', text: 'not a plan' }] },
      ],
    }));
    expect(chat.latestPlan?.turnId).toBe('alternate');
    expect(chat.latestPlan?.steps.map((step) => step.status)).toEqual(['completed', 'pending']);
    expect(chat.latestTurnPlan).toBeNull();
    expect(chat.activeTurnId).toBe('running');
    expect(mapChat(toRawThread({ id: 'empty', turns: [] })).latestPlan).toBeNull();
  });

  it('maps structured content aliases and ignores malformed entries', () => {
    const chat = mapChat(toRawThread({
      id: 'thr_content_edges',
      turns: [{ items: [
        { type: 'userMessage', content: [] },
        { type: 'userMessage', content: [{ type: 'text', data: { text: 'nested text' } }, 4] },
        { type: 'agentMessage', text: 'fallback text' },
        { type: 'reasoning', content: [{ type: 'output_text', text: 'structured reasoning' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', data: { text: 'nested summary' } }] },
        { type: 'agentMessage', content: [
          { type: 'image', data: { data: 'abc', mime_type: 'image/png' } },
          { type: 'localImage', data: { url: 'https://example.com/image.png' } },
          { type: 'mention', data: { path: 'nested.ts' } },
          { type: 'unsupported' },
        ] },
      ] }],
    }));
    const text = chat.messages.map((message) => message.content).join('\n');
    expect(text).toContain('nested text');
    expect(text).toContain('fallback text');
    expect(text).toContain('structured reasoning');
    expect(text).toContain('nested summary');
    expect(text).toContain('data:image/png;base64,abc');
    expect(text).toContain('[image: https://example.com/image.png]');
    expect(text).toContain('[file: nested.ts]');
  });
});
