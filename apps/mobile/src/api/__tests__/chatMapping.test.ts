import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  mapChat,
  mapChatSummary,
  readString,
  toPreview,
  toRawThread,
  toRecord,
} from '../chatMapping';
import { renderAgUiCustomContent } from '../agUi';
import {
  COMPACTION_ACTIVITY_TYPE,
  getMessageText,
  getSubAgentMeta,
  SUBAGENT_ACTIVITY_TYPE,
} from '../messages';

describe('chatMapping', () => {
  it('uses bridge session titles and ISO activity timestamps for drawer summaries', () => {
    const summary = mapChatSummary(toRawThread({
      id: 'v1.YWdlbnQ.c2Vzc2lvbg',
      name: 'Fix mobile session controls',
      createdAt: '2026-07-21T14:03:00.000Z',
      updatedAt: '2026-07-21T14:17:00.000Z',
      cwd: '/private/tmp/tethercode-playground-18787',
      status: { type: 'idle' },
      turns: [],
    }));

    expect(summary).toMatchObject({
      title: 'Fix mobile session controls',
      createdAt: '2026-07-21T14:03:00.000Z',
      updatedAt: '2026-07-21T14:17:00.000Z',
    });
  });

  it('gives titleless ACP sessions readable distinct fallback labels and times', () => {
    const first = mapChatSummary(toRawThread({
      id: 'v1.YWdlbnQ.c2VzX2FscGhh', status: { type: 'idle' }, turns: [],
      acpSnapshot: {
        version: 2, messages: [], tools: [], plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'agent', threadId: 'ses_alpha', historyReconstruction: false },
        active: { toolIds: [] },
      },
    }));
    const second = mapChatSummary(toRawThread({
      id: 'v1.YWdlbnQ.c2VzX2JldGE', status: { type: 'idle' }, turns: [],
      acpSnapshot: {
        version: 2, messages: [], tools: [], plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'agent', threadId: 'ses_beta', historyReconstruction: false },
        active: { toolIds: [] },
      },
    }));

    expect(first?.title).toBe('Session sesalpha');
    expect(second?.title).toBe('Session sesbeta');
    expect(first?.updatedAt).not.toBe(second?.updatedAt);
  });

  it('preserves advertised ACP model, effort, and primary mode options', () => {
    const chat = mapChat(toRawThread({
      id: 'v1.YWdlbnQ.c2Vzc2lvbg',
      name: 'Configured OpenCode session',
      createdAt: '2026-07-21T14:03:00.000Z',
      updatedAt: '2026-07-21T14:17:00.000Z',
      status: { type: 'idle' },
      acpSnapshot: {
        version: 2,
        messages: [], tools: [], plan: [], usage: {}, commands: [],
        config: [
          {
            id: 'model', value: 'github-copilot/gpt-5.4', name: 'Model', category: 'model',
            options: [{ value: 'github-copilot/gpt-5.4', name: 'GitHub Copilot/GPT-5.4' }],
          },
          {
            id: 'effort', value: 'high', name: 'Effort', category: 'thought_level',
            options: [{ value: 'none', name: 'None' }, { value: 'high', name: 'High' }],
          },
          {
            id: 'mode', value: 'build', name: 'Session Mode', category: 'mode',
            options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }],
          },
        ],
        session: { agentId: 'opencode', threadId: 'v1.YWdlbnQ.c2Vzc2lvbg', historyReconstruction: false },
        active: { toolIds: [] },
      },
      turns: [],
    }));

    expect(chat.acpConfig).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model', category: 'model', options: [expect.objectContaining({ value: 'github-copilot/gpt-5.4' })] }),
      expect.objectContaining({ id: 'effort', category: 'thought_level', value: 'high' }),
      expect.objectContaining({ id: 'mode', category: 'mode', value: 'build' }),
    ]));
  });

  it('converges snapshot and live chronology across messages, tools, reasoning, and updates', () => {
    const snapshot = mapChat(toRawThread({
      id: 'thread-order',
      createdAt: 1784419200,
      acpSnapshot: {
        version: 2,
        timeline: [
          { sequence: 0, kind: 'message', canonicalId: 'message-a' },
          { sequence: 1, kind: 'tool', canonicalId: 'tool-t' },
          { sequence: 2, kind: 'message', canonicalId: 'message-b' },
          { sequence: 3, kind: 'reasoning', canonicalId: 'reasoning-r' },
        ],
        messages: [
          { id: 'message-a', role: 'agent', parts: [{ type: 'text', text: 'A' }] },
          { id: 'message-b', role: 'agent', parts: [{ type: 'text', text: 'B' }] },
          { id: 'reasoning-r', role: 'thought', parts: [{ type: 'text', text: 'R' }] },
        ],
        tools: [{
          id: 'tool-t', kind: 'read', status: 'completed', title: 'T', content: 'updated',
          structuredContent: [], locations: [],
        }],
        plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'agent', threadId: 'thread-order', historyReconstruction: false },
        active: { toolIds: [] },
      },
    }));

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'message-a', 'tool:tool-t', 'message-b', 'reasoning-r',
    ]);
  });

  it('maps persisted OpenCode task tools to one non-navigable subagent card', () => {
    const mapped = mapChat(toRawThread({
      id: 'parent-thread',
      acpSnapshot: {
        version: 2,
        timeline: [{ sequence: 0, kind: 'tool', canonicalId: 'task-1' }],
        messages: [],
        tools: [{
          id: 'task-1',
          kind: 'think',
          status: 'completed',
          title: 'Inspect workspace',
          content: '<task id="child-session" state="completed">\n<task_result>Workspace title</task_result>\n</task>',
          structuredContent: [{ type: 'content', content: { type: 'text', text: 'duplicate' } }],
          locations: [],
        }],
        plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'opencode', threadId: 'parent-thread', historyReconstruction: false },
        active: { toolIds: [] },
      },
    }));

    expect(mapped.messages).toHaveLength(1);
    expect(mapped.messages[0]).toMatchObject({
      id: 'subagent:task-1',
      role: 'activity',
      activityType: SUBAGENT_ACTIVITY_TYPE,
    });
    expect(getMessageText(mapped.messages[0])).toContain('Latest: Workspace title');
    expect(getSubAgentMeta(mapped.messages[0])).toEqual({
        toolCallId: 'task-1',
        tool: 'spawnAgent',
        senderThreadId: 'parent-thread',
        receiverThreadIds: ['v1.b3BlbmNvZGU.Y2hpbGQtc2Vzc2lvbg'],
        agentStatus: 'completed',
        navigable: true,
    });
  });

  it('maps an in-progress task snapshot to a running subagent card before child XML', () => {
    const mapped = mapChat(toRawThread({
      id: 'parent-running-task',
      acpSnapshot: {
        version: 2,
        timeline: [{ sequence: 0, kind: 'tool', canonicalId: 'task-running' }],
        messages: [],
        tools: [{
          id: 'task-running', kind: 'other', status: 'in_progress', title: 'task', content: '',
          structuredContent: [], locations: [],
        }],
        plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'opencode', threadId: 'parent-running-task', historyReconstruction: false },
        active: { toolIds: ['task-running'] },
      },
    }));

    expect(mapped.messages).toHaveLength(1);
    expect(mapped.messages[0]).toMatchObject({
      id: 'subagent:task-running', role: 'activity', activityType: SUBAGENT_ACTIVITY_TYPE,
      content: expect.objectContaining({
        subAgent: expect.objectContaining({ toolCallId: 'task-running', agentStatus: 'running' }),
      }),
    });
  });

  it('maps the checked Rust ACP snapshot fixture without legacy turns', () => {
    const manifest = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../../../../contracts/bridge-rpc/v2/manifest.json'),
        'utf8'
      )
    ) as { fixtures: { threadSnapshot: unknown } };
    const raw = toRawThread(manifest.fixtures.threadSnapshot);
    const chat = mapChat(raw);

    expect(chat.messages.map((message) => message.id)).toEqual([
      'message-1',
      'tool:tool-1',
      'reasoning-1',
    ]);
    expect(chat.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'message-1',
          role: 'assistant',
          content: expect.stringMatching(/Snapshot A[\s\S]*\[image: data:image\/png;base64,aW1hZ2U=\][\s\S]*Snapshot B[\s\S]*\[resource: file:\/\/\/tmp\/result.txt\][\s\S]*embedded result[\s\S]*\[audio: audio\/wav\]/),
        }),
        expect.objectContaining({ id: 'reasoning-1', role: 'reasoning' }),
        expect.objectContaining({
          id: 'tool:tool-1',
          role: 'tool',
          toolCallId: 'tool-1',
          content: expect.stringMatching(/done[\s\S]*structured[\s\S]*\[diff: src\/file.ts\][\s\S]*\[terminal: terminal-1\][\s\S]*\[location: src\/file.ts:7\]/),
        }),
      ])
    );
    const snapshotTool = raw.acpSnapshot?.tools[0];
    expect(snapshotTool).toBeDefined();
    expect(chat.messages.find((message) => message.id === 'tool:tool-1')?.content).toContain(
      renderAgUiCustomContent({
        content: snapshotTool?.structuredContent,
        locations: snapshotTool?.locations,
      })
    );
    expect(chat.latestPlan?.steps).toEqual([
      { step: 'Inspect state', status: 'completed' },
    ]);
    expect(chat.activeTurnId).toBe('turn-7');
    expect(chat).toMatchObject({
      acpUsage: { used: 120, size: 4096, cost: '$0.01' },
      acpMode: 'plan',
      acpConfig: [{ id: 'model', value: 'example-model' }],
      acpCommands: [{ name: 'test', description: 'Run tests' }],
      acpActive: { runId: 'run-7', generation: 7, toolIds: ['tool-live'] },
    });
    expect(raw.acpSnapshot?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'message-1',
        parts: [
          { type: 'text', text: 'Snapshot A' },
          expect.objectContaining({ type: 'image' }),
          { type: 'text', text: 'Snapshot B' },
          expect.objectContaining({ type: 'resource' }),
          expect.objectContaining({ type: 'audio' }),
        ],
      }),
    ]));
    expect(chat.messages[0]?.parts).toEqual(raw.acpSnapshot?.messages[0]?.parts);
    expect(raw.acpSnapshot?.tools[0]).toMatchObject({
      structuredContent: expect.arrayContaining([
        expect.objectContaining({ type: 'diff' }),
        expect.objectContaining({ type: 'terminal' }),
      ]),
      locations: [{ path: 'src/file.ts', line: 7 }],
    });
    expect(raw.acpSnapshot).toMatchObject({
      usage: { used: 120, size: 4096, cost: '$0.01' },
      mode: 'plan',
      config: [{ id: 'model', value: 'example-model' }],
      commands: [{ name: 'test', description: 'Run tests' }],
      active: { runId: 'run-7', generation: 7, toolIds: ['tool-live'] },
    });
  });

  it('preserves and presents message, reasoning, tool, and unavailable-history truncation', () => {
    const raw = toRawThread({
      id: 'truncated-thread',
      createdAt: 1784419200,
      acpSnapshot: {
        version: 2,
        timeline: [
          { sequence: 4, kind: 'message', canonicalId: 'message' },
          { sequence: 5, kind: 'reasoning', canonicalId: 'reasoning' },
          { sequence: 6, kind: 'tool', canonicalId: 'tool' },
        ],
        messages: [
          { id: 'message', role: 'agent', parts: [{ type: 'text', text: 'answer' }], truncated: true },
          { id: 'reasoning', role: 'thought', parts: [{ type: 'text', text: 'thought' }], truncated: true },
        ],
        tools: [{ id: 'tool', kind: 'read', status: 'completed', title: 'Read', content: 'result', structuredContent: [], locations: [], truncated: true }],
        messageCollection: { truncated: true, omittedCount: 2, revision: 7 },
        reasoningCollection: { truncated: true, omittedCount: 1, revision: 7 },
        toolCollection: { truncated: true, omittedCount: 3, revision: 7 },
        continuation: { revision: 7, unavailableCount: 4, maxPageSize: 100, maxHistoryEntries: 1024, maxHistoryBytes: 4194304 },
        plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'agent', threadId: 'truncated-thread', historyReconstruction: false },
        active: { toolIds: [] },
      },
    });
    const chat = mapChat(raw);
    expect(raw.acpSnapshot?.messages.every((message) => message.truncated)).toBe(true);
    expect(raw.acpSnapshot?.tools[0]?.truncated).toBe(true);
    expect(chat.messages[0]?.content).toContain('Snapshot truncated');
    expect(chat.messages[0]?.content).toContain('older history unavailable: 4');
    expect(chat.messages.find((message) => message.id === 'message')?.content).toContain('[message content truncated]');
    expect(chat.messages.find((message) => message.id === 'tool:tool')?.content).toContain('[tool content truncated]');
  });

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
    expect(chat.messages[1].role).toBe('tool');
    expect(getMessageText(chat.messages[1])).toContain('• Ran `git status --short`');
    expect(getMessageText(chat.messages[1])).toContain('M apps/mobile/src/api/ws.ts');
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

    const toolMessages = chat.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(4);
    expect(getMessageText(toolMessages[0])).toContain('• Explored');
    expect(getMessageText(toolMessages[1])).toContain('• Searched web for "react native keyboard inset"');
    expect(getMessageText(toolMessages[2])).toContain('• Called tool `filesystem / read_file`');
    expect(getMessageText(toolMessages[3])).toContain('• Applied file changes to MainScreen.tsx');
    expect(getMessageText(toolMessages[3])).toContain('apps/mobile/src/screens/MainScreen.tsx');
  });

  it('maps function call items into visible tool timeline entries', () => {
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

    const toolMessages = chat.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(getMessageText(toolMessages[0])).toContain(
      "• Ran `sed -n '1,80p' apps/mobile/src/api/chatMapping.ts`"
    );
    expect(getMessageText(toolMessages[0])).toContain('cwd: /repo');
    expect(getMessageText(toolMessages[1])).toContain('• Tool output `call_read_file`');
    expect(getMessageText(toolMessages[1])).toContain('import type { Chat }');
    expect(getMessageText(toolMessages[2])).toContain('• Tool output `custom_call_read_file`');
    expect(getMessageText(toolMessages[2])).toContain('custom output');
  });

  it('maps MCP and search function calls into readable timeline entries', () => {
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
    expect(chat.messages[0].role).toBe('tool');
    expect(getMessageText(chat.messages[0])).toContain(
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
    expect(chat.messages[0].role).toBe('reasoning');
    expect(getMessageText(chat.messages[0])).toContain('• Reasoning');
    expect(getMessageText(chat.messages[0])).toContain('Inspecting the current workspace');
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
    expect(chat.messages[0].role).toBe('activity');
    expect(chat.messages[0].role === 'activity' && chat.messages[0].activityType).toBe(COMPACTION_ACTIVITY_TYPE);
    expect(getMessageText(chat.messages[0])).toContain('Compacted conversation context');
  });

  it('maps reasoning items that use content arrays', () => {
    const chat = mapChat(
      toRawThread({
        id: 'thr_agent_reasoning',
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
                id: 'reasoning_agent_1',
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
    expect(chat.messages[0].role).toBe('reasoning');
    expect(getMessageText(chat.messages[0])).toContain('Checking how the bridge forwards live events.');
    expect(getMessageText(chat.messages[0])).toContain('Comparing persisted thread items with live deltas.');
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
    expect(chat.messages[0].role).toBe('reasoning');
    expect(getMessageText(chat.messages[0])).toContain('• Reasoning');
    expect(getMessageText(chat.messages[0])).toContain(
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
    expect(chat.messages[0].role).toBe('activity');
    expect(chat.messages[0].role === 'activity' && chat.messages[0].activityType).toBe(SUBAGENT_ACTIVITY_TYPE);
    expect(getMessageText(chat.messages[0])).toContain('• Spawned sub-agent');
    expect(getMessageText(chat.messages[0])).toContain('Prompt: Inspect the websocket protocol');
    expect(getMessageText(chat.messages[0])).toContain('Thread: thr_sub');
    expect(getSubAgentMeta(chat.messages[0])).toEqual({
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
    expect(chat.messages[0].role).toBe('tool');
    expect(getMessageText(chat.messages[0])).toContain('• Called tool `computer_use / get_app_state`');
    expect(getMessageText(chat.messages[0])).toContain('Computer Use state');
    expect(getMessageText(chat.messages[0])).toContain(`[image: ${dataUrl}]`);
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
    expect(chat.messages[0].role).toBe('tool');
    expect(getMessageText(chat.messages[0])).toContain('• Called tool `computer-use / get_app_state`');
    expect(getMessageText(chat.messages[0])).toContain('Computer Use state');
    expect(getMessageText(chat.messages[0])).toContain(`[image: ${dataUrl}]`);
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
    expect(chat.messages[0].role).toBe('tool');
    expect(getMessageText(chat.messages[0])).toContain('• Called tool `computer-use / get_app_state`');
    expect(getMessageText(chat.messages[0])).toContain('Computer Use state');
    expect(getMessageText(chat.messages[0])).toContain(
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
    expect(chat.messages[0].role).toBe('tool');
    expect(getMessageText(chat.messages[0])).toContain('• Viewed image bridge-pairing-qr.png');
    expect(getMessageText(chat.messages[0])).toContain('/tmp/bridge-pairing-qr.png');
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
    expect(getMessageText(chat.messages[0])).toContain(expected);
    expect(getSubAgentMeta(chat.messages[0])).toEqual(expect.objectContaining({ tool }));
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
