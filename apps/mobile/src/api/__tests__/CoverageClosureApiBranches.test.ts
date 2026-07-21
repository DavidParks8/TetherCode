import { EventType, type AGUIEvent } from '@ag-ui/core';
import * as FileSystem from 'expo-file-system/legacy';

import {
  parseAgUiEventNotification,
  renderAgUiCustomContent,
  updateAgUiLiveAssistantMessages,
  type AgUiEventEnvelope,
  type AgUiLiveAssistantMessages,
} from '../agUi';
import {
  applySnapshotToChat,
  mapChat,
  mapChatSummary,
  readString,
  toPreview,
  toRawThread,
  toRecord,
  type RawAcpSnapshot,
  type RawThreadItem,
} from '../chatMapping';
import {
  HostBridgeApiClient,
  StaleSnapshotRevisionError,
  mergeSnapshotPage,
} from '../client';
import type { Chat, ChatSummary, RpcNotification } from '../types';
import type { HostBridgeWsClient } from '../ws';

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 1 },
}));

type WsRequest = HostBridgeWsClient['request'];

function createWsMock() {
  const onEvent = jest.fn().mockReturnValue(jest.fn());
  return {
    request: jest.fn() as jest.MockedFunction<WsRequest>,
    waitForTurnCompletion: jest.fn().mockResolvedValue(undefined),
    onEvent,
  };
}

function makeSnapshot(overrides: Partial<RawAcpSnapshot> = {}): RawAcpSnapshot {
  return {
    version: 2,
    messages: [],
    tools: [],
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: {
      agentId: 'agent',
      threadId: 'thread',
      historyReconstruction: false,
    },
    active: { toolIds: [] },
    ...overrides,
  };
}

function malformedItems(items: unknown[]): RawThreadItem[] {
  return items as RawThreadItem[];
}

function reduceEvents(events: AGUIEvent[]): AgUiLiveAssistantMessages {
  return events.reduce(
    (state, event) => updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread',
      runId: 'run',
      event,
    }),
    {} as AgUiLiveAssistantMessages
  );
}

describe('CoverageClosure chat mapping branches', () => {
  it('maps sparse and invalid raw thread payloads through DTO fallbacks', () => {
    expect(toRawThread(null)).toEqual(expect.objectContaining({
      id: undefined,
      turns: undefined,
      acpSnapshot: undefined,
    }));
    expect(toRawThread({ acpSnapshot: { version: 3, session: {}, active: {} } }).acpSnapshot).toBeUndefined();
    expect(toRawThread({ acpSnapshot: { version: 2, session: null, active: {} } }).acpSnapshot).toBeUndefined();
    expect(toRawThread({ acpSnapshot: { version: 2, session: {}, active: null } }).acpSnapshot).toBeUndefined();

    const raw = toRawThread({
      id: 'sparse',
      title: 'title fallback',
      agent_nickname: 'nick',
      agent_role: 'role',
      updatedAt: '1700000001',
      status: null,
      turns: [null, 3, { id: 4, status: 5, items: 'bad' }],
      acpSnapshot: { version: 1, session: {}, active: {} },
    });
    expect(raw).toMatchObject({
      name: 'title fallback',
      agentNickname: 'nick',
      agentRole: 'role',
      updatedAt: 1700000001,
      turns: [{ items: undefined }],
    });
    expect(raw.acpSnapshot).toMatchObject({
      version: 1,
      messages: [],
      tools: [],
      plan: [],
      usage: { used: null, size: null, cost: null },
      config: [],
      commands: [],
      session: { agentId: '', threadId: '', title: null, updatedAt: null, historyReconstruction: false },
      active: { runId: null, sourceTurnId: null, generation: null, toolIds: [] },
    });
    expect(mapChatSummary(raw)).toMatchObject({
      title: 'title fallback',
      createdAt: '2023-11-14T22:13:21.000Z',
      cwd: undefined,
      agentId: null,
    });
    expect(() => mapChat({})).toThrow('chat id missing');
  });

  it('covers status aliases, title priorities, and source union fallbacks', () => {
    const statusCases = [
      ['inProgress', 'running'], ['queued', 'running'], ['pending', 'running'],
      ['failed', 'error'], ['error', 'error'],
    ] as const;
    statusCases.forEach(([status, expected]) => {
      expect(mapChatSummary({ id: status, status })?.status).toBe(expected);
    });
    const turnCases = [
      ['running', 'running'], ['active', 'running'], ['queued', 'running'],
      ['interrupted', 'error'], ['error', 'error'], ['cancelled', 'error'],
      ['completed', 'complete'], ['success', 'complete'],
    ] as const;
    turnCases.forEach(([status, expected]) => {
      expect(mapChatSummary({ id: `turn-${status}`, turns: [{ status }] })?.status).toBe(expected);
    });
    expect(mapChatSummary({ id: 'preview', preview: 'preview title' })?.title).toBe('preview title');
    expect(mapChatSummary({
      id: 'user-title', turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'first user' }] }] }],
    })?.title).toBe('first user');
    expect(mapChatSummary({ id: 'abcdefghijk' })?.title).toBe('Chat abcdefgh');
    expect(mapChatSummary({ id: 'source-invalid', source: 3 })?.sourceKind).toBeUndefined();
    expect(mapChatSummary({ id: 'source-subagent', source: { subAgent: 4 } })?.sourceKind).toBe('subAgent');
    expect(mapChatSummary({ id: 'source-object', source: { subAgent: { parent_thread_id: 'p', agentDepth: '4' } } })).toMatchObject({
      sourceKind: 'subAgent', parentThreadId: 'p', subAgentDepth: 4,
    });
    expect(mapChatSummary({ id: 'source-none', source: { type: 'cli' } })?.sourceKind).toBeUndefined();
  });

  it('maps alternate primitive, timestamp, lifecycle, title, source, and error shapes', () => {
    expect(toRecord([])).toBeTruthy();
    expect(toRecord(null)).toBeNull();
    expect(readString(4)).toBeNull();
    expect(toPreview(` ${'word '.repeat(50)}`)).toHaveLength(180);

    const cases = [
      { status: 'running', turns: [], expected: 'running' },
      { status: 'active', turns: [], expected: 'idle' },
      { status: 'active', turns: [{ status: 'complete' }], expected: 'complete' },
      { status: 'idle', turns: [{ status: 'pending' }], expected: 'complete' },
      { status: 'unknown', turns: [{ status: 'succeeded' }], expected: 'complete' },
      { status: 'system-error', turns: [], expected: 'error' },
      { status: 'unknown', turns: [{ status: 'canceled' }], expected: 'error' },
    ];
    cases.forEach(({ status, turns, expected }, index) => {
      expect(mapChatSummary(toRawThread({
        id: `status-${index}`,
        thread_name: index === 0 ? 'alternate title' : undefined,
        createdAt: index === 0 ? '1700000000' : 1700000000,
        status,
        turns,
      }))?.status).toBe(expected);
    });

    const summaries = [
      toRawThread({ id: 'legacy', source: { kind: 'subAgentLegacy', parent_thread_id: 'parent', agent_depth: '2' } }),
      toRawThread({ id: 'review', source: { subAgent: 'review' } }),
      toRawThread({ id: 'compact', source: { subagent: 'compact' } }),
      toRawThread({ id: 'memory', source: { subAgent: 'memory_consolidation' } }),
      toRawThread({ id: 'spawn', source: { subAgent: { thread_spawn: { parent_thread_id: 'p', depth: 3 } } } }),
      toRawThread({ id: 'other', source: { subAgent: { other: 'kind' } } }),
      toRawThread({ id: 'typed', source: { type: 'subAgentCustom', parentThreadId: 'p' } }),
      toRawThread({ id: 'plain', source: 'cli' }),
    ].map((raw) => mapChatSummary(raw));
    expect(summaries.map((summary) => summary?.sourceKind)).toEqual([
      'subAgentLegacy', 'subAgentReview', 'subAgentCompact', 'subAgentOther',
      'subAgentThreadSpawn', 'subAgentOther', 'subAgentCustom', 'cli',
    ]);

    const errorFields = ['message', 'errorMessage', 'error_message', 'detail', 'details', 'reason', 'description', 'stderr'];
    errorFields.forEach((field) => {
      const summary = mapChatSummary(toRawThread({
        id: `error-${field}`,
        turns: [{ status: 'failed', [field]: { error: { message: `${field} failure` } } }],
      }));
      expect(summary?.lastError).toBe(`${field} failure`);
    });
  });

  it('sanitizes typed snapshots and maps timeline fallbacks and plan states', () => {
    const raw = toRawThread({
      id: 'snapshot',
      acpSnapshot: {
        version: '2',
        messages: [
          null,
          { id: '', role: 'agent' },
          { id: 'user', role: 'user', parts: [{ type: 'text', text: 'question' }, { type: 'bad' }] },
          { id: 'thought', role: 'thought', parts: [{ type: 'text', text: 'reason' }], truncated: true },
          { id: 'empty', role: 'agent', parts: [] },
        ],
        timeline: [
          null,
          { sequence: -1, kind: 'message', canonicalId: 'user' },
          { sequence: 0, kind: 'bad', canonicalId: 'user' },
          { sequence: 1, kind: 'message', canonicalId: 'missing' },
          { sequence: 2, kind: 'tool', canonicalId: 'missing' },
          { sequence: 3, kind: 'message', canonicalId: 'user' },
        ],
        tools: [
          null,
          { id: '' },
          { id: 'tool', generation: '4', kind: 'read', status: 'complete', title: '', content: '', structuredContent: [], locations: [], truncated: true },
        ],
        messageCollection: { truncated: false, omittedCount: '2', revision: '7' },
        reasoningCollection: { revision: 'bad' },
        continuation: { revision: '7', unavailableCount: '2', maxPageSize: '50', maxHistoryEntries: 100, maxHistoryBytes: 200 },
        plan: [
          null,
          { content: '', priority: '', status: '' },
          { content: 'done', priority: 'high', status: 'completed' },
          { content: 'doing', priority: 'high', status: 'in_progress' },
          { content: 'later', priority: 'low', status: 'unknown' },
        ],
        usage: { used: '5', size: 'bad', cost: 3 },
        mode: 2,
        config: [null, { id: '', value: '' }, { id: 'model', value: 'x' }],
        commands: [null, { name: '', description: '' }, { name: 'go', description: 3 }],
        session: { agentId: 'agent', threadId: 'snapshot', title: 4, updatedAt: null, historyReconstruction: true },
        active: { runId: '', sourceTurnId: null, generation: '4', toolIds: [' one ', '', 3, 'two'] },
      },
    });
    const chat = mapChat(raw);
    expect(raw.acpSnapshot).toMatchObject({
      version: 2,
      usage: { used: 5, size: null, cost: null },
      config: [{ id: 'model', value: 'x' }],
      commands: [{ name: 'go', description: '' }],
      active: { generation: 4, toolIds: ['one', 'two'] },
    });
    expect(chat.messages.map((message) => message.id)).toEqual([
      'snapshot::snapshot-truncated',
      'user',
    ]);
    expect(chat.latestPlan?.steps.map((step) => step.status)).toEqual([
      'completed', 'inProgress', 'pending',
    ]);
    expect(chat.latestTurnStatus).toBe('completed');

    const withoutTimeline = mapChat({
      id: 'fallback',
      createdAt: 1700000000,
      acpSnapshot: makeSnapshot({
        messages: [
          { id: 'agent', role: 'agent', parts: [{ type: 'text', text: 'answer' }], truncated: false },
          { id: 'thought', role: 'thought', parts: [{ type: 'text', text: 'reason' }], truncated: false },
        ],
        tools: [{ id: 'tool', kind: '', status: '', title: '', content: '', structuredContent: [], locations: [], truncated: false }],
        active: { runId: 'run', sourceTurnId: null, toolIds: [] },
      }),
    });
    expect(withoutTimeline.messages.map((message) => message.id)).toEqual(['agent', 'thought', 'tool:tool']);
    expect(withoutTimeline.latestTurnStatus).toBe('running');
  });

  it('maps legacy plans, structured messages, and every tool timeline family', () => {
    const chat = mapChat(toRawThread({
      id: 'legacy-items',
      createdAt: 1700000000,
      turns: [
        {
          id: 'turn-active',
          status: 'in_progress',
          items: [
            null,
            { type: 'userMessage', content: [{ type: 'text', text: '' }] },
            { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'image', imageUrl: 'image.png' }, { type: 'localImage', path: '/tmp/local.png' }, { type: 'mention', path: 'src/a.ts' }] },
            { type: 'agentMessage', content: [{ type: 'output_text', data: { text: 'answer' } }] },
            { type: 'plan', id: 'plan', text: 'Implementation Plan\nSummary\nExplain it\n1. First\n2) Second' },
            { type: 'reasoning', content: [{ type: 'summary_text', text: 'thought' }] },
            { type: 'commandExecution', command: '', status: 'failed', aggregated_output: '\u001b[31mfailed\u001b[0m', exit_code: 2 },
            { type: 'mcpToolCall', status: 'failed', error: { message: 'nope' } },
            { type: 'function_call', name: 'exec_command', status: 'running', args: { command: ['npm', 'test'] } },
            { type: 'function_call', name: 'mcp__server__tool__part', status: 'running', arguments: { value: true } },
            { type: 'function_call', name: 'plain', status: 'failed', arguments: '{bad' },
            { type: 'function_call_output', output: { ok: true } },
            { type: 'collabToolCall', tool: 'spawnAgent', status: 'completed', receiver_thread_ids: ['child', 'child'], sender_thread_id: 'parent', agent_status: 'done' },
            { type: 'collabToolCall', tool: 'sendInput', status: 'failed', receiverThreadId: 'child' },
            { type: 'collabToolCall', tool: 'wait', status: 'failed' },
            { type: 'collabToolCall', tool: 'closeAgent', status: 'completed' },
            { type: 'collabToolCall', tool: 'other', status: 'failed' },
            { type: 'webSearch', action: { type: 'openPage', url: 'https://example.com' } },
            { type: 'webSearch', action: { type: 'findInPage', url: 'https://example.com', pattern: 'needle' } },
            { type: 'fileChange', status: 'failed', changes: ['a\\b.ts', { file_path: 'c.ts' }, { filePath: 'c.ts' }] },
            { type: 'imageView', path: '/tmp/image.png' },
            { type: 'enteredReviewMode' },
            { type: 'exitedReviewMode' },
            { type: 'contextCompaction' },
          ],
        },
      ],
    }));
    expect(chat.status).toBe('running');
    expect(chat.activeTurnId).toBe('turn-active');
    expect(chat.latestPlan).toMatchObject({
      explanation: 'Explain it',
      steps: [{ step: 'First', status: 'pending' }, { step: 'Second', status: 'pending' }],
    });
    expect(chat.messages.map((message) => message.systemKind)).toEqual(expect.arrayContaining([
      'reasoning', 'subAgent', 'compaction',
    ]));
    expect(chat.messages.map((message) => message.content).join('\n')).toMatch(
      /Command failed|Tool failed|Running command|Calling tool|Spawned sub-agent|Searched web|Viewed image|Entered review mode|Compacted/
    );
  });

  it('covers alternate plan records and tool success, empty, and fallback details', () => {
    const chat = mapChat({
      id: 'alternate-tools',
      createdAt: 1700000000,
      turns: [{
        id: 'turn', status: 'completed', items: malformedItems([
          { type: 'plan', turn_id: 'override', explanation: 'explained', steps: [null, { step: '', status: 'pending' }, { step: 'pending', status: 'pending' }, { step: 'doing', status: 'in-progress' }, { step: 'done', status: 'complete' }] },
          { type: 'reasoning', text: 'direct thought' },
          { type: 'reasoning', summary: ['summary one', '', 3, 'summary two'] },
          { type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0 },
          { type: 'mcpToolCall', server: 'server', tool: 'tool', status: 'completed', result: 'ok' },
          { type: 'mcpToolCall', server: 'server', tool: 'tool', status: 'error', error: 'failure' },
          { type: 'function_call', function_name: 'exec_command', status: 'error', input: 'echo bad' },
          { type: 'function_call', function: 'search_query', args: { q: 'query' } },
          { type: 'function_call', tool: 'image_query', args: { image_query: [{ query: 'image' }] } },
          { type: 'custom_tool_call', name: 'apply_patch', input: '*** Add File: a.ts\n*** Delete File: b.ts' },
          { type: 'custom_tool_call', name: 'tool', arguments: { content: [{ type: 'text', text: 'input' }] } },
          { type: 'function_call_output', callId: 'call', output: '' },
          { type: 'collabToolCall', tool: 'spawnAgent', status: 'failed', new_thread_id: 'child' },
          { type: 'collabToolCall', tool: 'sendInput', status: 'completed', prompt: 'go' },
          { type: 'collabToolCall', tool: 'wait', status: 'completed' },
          { type: 'collabToolCall', tool: 'closeAgent', status: 'failed' },
          { type: 'collabToolCall', tool: 'other', status: 'completed' },
          { type: 'webSearch' },
          { type: 'fileChange', status: 'completed', changes: [] },
          { type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts' }] },
          { type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
          { type: 'imageView' },
          { type: 'unknown' },
        ]),
      }],
    });
    expect(chat.latestPlan).toMatchObject({
      turnId: 'override', explanation: 'explained',
      steps: [
        { step: 'pending', status: 'pending' },
        { step: 'doing', status: 'inProgress' },
        { step: 'done', status: 'completed' },
      ],
    });
    expect(chat.messages.map((message) => message.content).join('\n')).toMatch(
      /Ran `true`|Called tool|Command failed|Searched web|Applied file changes|Sub-agent spawn failed/
    );
  });

  it('covers snapshot field defaults, plan parser edges, and structured media variants', () => {
    const raw = toRawThread({
      id: 'defaults',
      source: { subAgent: { thread_spawn: { parentThreadId: 'parent', agentDepth: 2 } } },
      acpSnapshot: {
        version: 2,
        messages: [{ id: 4, role: 5, parts: [], truncated: false }],
        tools: [{ id: 'tool', kind: 4, status: 5, title: 6, content: 7 }],
        timeline: [{ sequence: 'bad', kind: 'message', canonicalId: 4 }],
        plan: [{ content: 4, priority: 5, status: 6 }],
        messageCollection: { truncated: true, revision: 1 },
        continuation: { revision: 1 },
        config: [{ id: 'config' }, { id: 4, value: 5 }],
        commands: [{ name: 'command' }, { name: 4, description: 5 }],
        session: { agentId: 'agent', threadId: 'defaults' },
        active: {},
      },
    });
    expect(raw.acpSnapshot).toMatchObject({
      messages: [],
      tools: [expect.objectContaining({ kind: '', status: '', title: '', content: '' })],
      plan: [],
      messageCollection: expect.objectContaining({ omittedCount: 0 }),
      continuation: expect.objectContaining({ unavailableCount: 0, maxPageSize: 0, maxHistoryEntries: 0, maxHistoryBytes: 0 }),
      config: [{ id: 'config', value: '' }],
      commands: [{ name: 'command', description: '' }],
    });

    const planCases = [
      { id: 'no-turn', turns: [{ items: [{ type: 'plan', explanation: 'x' }] }] },
      { id: 'blank-plan', turns: [{ id: 'turn', items: [{ type: 'plan', text: '   ' }] }] },
      { id: 'header-only', turns: [{ id: 'turn', items: [{ type: 'plan', text: 'Summary' }] }] },
      { id: 'proposed', turns: [{ id: 'turn', items: [{ type: 'plan', text: 'Proposed Plan\nSummary\nDetails only' }] }] },
      { id: 'number-only', turns: [{ id: 'turn', items: [{ type: 'plan', text: '1. Step' }] }] },
    ];
    const plans = planCases.map((value) => mapChat(value).latestPlan);
    expect(plans[0]).toBeNull();
    expect(plans[1]).toBeNull();
    expect(plans[2]).toBeNull();
    expect(plans[3]?.explanation).toBe('Details only');
    expect(plans[4]?.steps).toEqual([{ step: 'Step', status: 'pending' }]);

    const structured = mapChat({
      id: 'structured',
      turns: [{ id: 'turn', items: malformedItems([
        { type: 'userMessage', content: [null, 'plain', { type: 'text', text: 3 }, { type: 'inputImage', data: { data: 'YQ==', mime_type: 'image/png' } }, { type: 'localImage', data: { url: 'remote.png' } }, { type: 'mention', data: { path: 'src/a.ts' } }] },
        { type: 'agentMessage', text: '' },
        { type: 'reasoning', content: [{ type: 'text', text: '' }], summary: [{ type: 'summaryText', data: { text: 'summary' } }] },
        { type: 'custom_tool_call', name: '', input: '' },
      ]) }],
    });
    expect(structured.messages.map((message) => message.content).join('\n')).toMatch(/plain|image\/png|remote\.png|src\/a\.ts|summary|Called tool/);
  });

  it('covers remaining mapper fallbacks through malformed and alternate timeline items', () => {
    const summary = mapChatSummary({
      id: 'active-turn', status: 'active', turns: [{ status: 'unknown' }],
      source: { kind: 'legacy', parentThreadId: 'parent', depth: 2 },
    });
    expect(summary).toMatchObject({ status: 'complete', parentThreadId: 'parent', subAgentDepth: 2 });
    expect(mapChatSummary({
      id: 'typed-source', source: { type: 'subAgentType', parent_thread_id: 'parent', agent_depth: 3 },
    })).toMatchObject({ parentThreadId: 'parent', subAgentDepth: 3 });
    expect(mapChatSummary({
      id: 'spawn-source', source: { subAgent: { thread_spawn: { parentThreadId: 'parent', depth: 1 } } },
    })).toMatchObject({ parentThreadId: 'parent', subAgentDepth: 1 });
    expect(mapChatSummary({
      id: 'object-source', source: { subAgent: { parentThreadId: 'parent', depth: 1 } },
    })).toMatchObject({ parentThreadId: 'parent', subAgentDepth: 1 });

    const chat = mapChat({
      id: 'remaining-items',
      turns: [{ id: 'turn', status: 'completed', items: malformedItems([
        3 as never,
        { type: 'commandExecution', status: undefined, aggregatedOutput: '', exitCode: 7 },
        { type: 'mcpToolCall', status: undefined, result: { content: [{ type: 'text', text: 'result' }] } },
        { type: 'mcpToolCall', status: 'failed', result: 'fallback result' },
        { type: 'collabToolCall', tool: undefined, status: undefined },
        { type: 'function_call', name: 'exec_command', status: 'failed' },
        { type: 'function_call', name: 'exec_command', status: 'running' },
        { type: 'function_call', name: 'exec_command' },
        { type: 'function_call', name: 'mcp__server__tool' },
        { type: 'function_call', name: 'search_query', arguments: {} },
        { type: 'function_call', name: 'image_query', args: { image_query: [{ q: 'image query' }] } },
        { type: 'custom_tool_call', name: 'apply_patch' },
        { type: 'custom_tool_call', name: 'apply_patch', input: 'not a patch' },
        { type: 'function_call', name: 'mcp__broken' },
        { type: 'function_call', name: 'plain' },
        { type: 'fileChange', changes: 'bad' },
        { type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'a.ts' }, {}] },
        { type: 'webSearch', action: { type: 'openPage' } },
        { type: 'webSearch', action: { type: 'findInPage' } },
        { type: 'reasoning', summary: [{ type: 'text', text: '' }] },
      ]) }],
    });
    expect(chat.messages.map((message) => message.content).join('\n')).toMatch(/exit code 7|fallback result|Command failed|Running command|Searched web|Applied file changes/);

    const snapshot = mapChat({
      id: 'empty-snapshot',
      acpSnapshot: makeSnapshot({
        timeline: [
          { sequence: 0, kind: 'message', canonicalId: 'empty' },
          { sequence: 1, kind: 'tool', canonicalId: 'tool' },
        ],
        messages: [{ id: 'empty', role: 'agent', parts: [null, { type: 'resourceLink' }], truncated: false }],
        tools: [{ id: 'tool', kind: '', status: '', title: '', content: '', structuredContent: [], locations: [], truncated: true }],
        messageCollection: { truncated: true, omittedCount: 0, revision: 1 },
      }),
    });
    expect(snapshot.messages.map((message) => message.id)).toEqual(['empty-snapshot::snapshot-truncated', 'tool:tool']);
  });

  it('applies a snapshot while preserving shell-owned fields', () => {
    const summary = mapChatSummary({ id: 'thread', preview: 'preview' }) as ChatSummary;
    const shell: Chat = {
      ...summary,
      title: 'Pinned title',
      status: 'running',
      statusUpdatedAt: '2026-01-01T00:00:00.000Z',
      messages: [],
      latestPlan: null,
      latestTurnPlan: null,
      latestTurnStatus: null,
      activeTurnId: null,
    };
    const updated = applySnapshotToChat(shell, makeSnapshot({
      messages: [{ id: 'answer', role: 'agent', parts: [{ type: 'text', text: 'done' }], truncated: false }],
    }));
    expect(updated).toMatchObject({ title: 'Pinned title', status: 'running' });
    expect(updated.messages[0]?.content).toBe('done');
  });
});

describe('CoverageClosure AG-UI branches', () => {
  it('rejects wrong routing and malformed envelopes and accepts optional source turns', () => {
    const invalid = [
      { method: 'other', params: {} },
      { method: 'bridge/agui.event', params: [] },
      { method: 'bridge/agui.event', params: { threadId: '', runId: 'run', event: {} } },
      { method: 'bridge/agui.event', params: { threadId: 'thread', runId: '', event: {} } },
      { method: 'bridge/agui.event', params: { threadId: 'thread', runId: 'run', event: {} } },
      { method: 'bridge/agui.event', params: { threadId: 'thread', runId: 'run', event: { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'other' } } },
    ];
    invalid.forEach((notification) => expect(parseAgUiEventNotification(notification as unknown as RpcNotification)).toBeNull());
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread', runId: 'run', sourceTurnId: 'turn',
        event: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
      },
    })?.sourceTurnId).toBe('turn');
  });

  it('covers reducer no-ops, implicit starts, terminal marking, and snapshots', () => {
    const existing: AgUiLiveAssistantMessages = {
      thread: [{ runId: 'run', messageId: 'same', text: 'old', role: 'assistant' }],
    };
    expect(updateAgUiLiveAssistantMessages({}, {
      threadId: 'missing', runId: 'run',
      event: { type: EventType.RUN_STARTED, threadId: 'missing', runId: 'run' },
    })).toEqual({});
    expect(updateAgUiLiveAssistantMessages(existing, {
      threadId: 'thread', runId: 'run',
      event: { type: EventType.TEXT_MESSAGE_START, messageId: 'bad', role: 'system' },
    })).toBe(existing);
    expect(updateAgUiLiveAssistantMessages(existing, {
      threadId: 'thread', runId: 'run',
      event: { type: EventType.TEXT_MESSAGE_START, messageId: 'same', role: 'assistant' },
    })).toBe(existing);

    const state = reduceEvents([
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'implicit', delta: '' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'implicit', delta: 'A' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'implicit' },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reason', delta: 'R' },
      { type: EventType.REASONING_MESSAGE_END, messageId: 'reason' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tool', delta: '{}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tool' },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: 'implicit', role: 'assistant', content: [{ type: 'text', text: 'snapshot' }] },
          { id: 'reason', role: 'reasoning', content: 'thought' },
          { id: 'ignored', role: 'user', content: 'user' },
        ],
      } as unknown as AGUIEvent,
      { type: EventType.RUN_ERROR, message: 'done' },
    ]);
    expect(state.thread.map((message) => message.messageId)).toEqual(['tool:tool', 'implicit', 'reason']);
    expect(state.thread.every((message) => message.terminal)).toBe(true);
  });

  it('validates chunk metadata and handles reset, parse failure, and completed assemblies', () => {
    const chunk = (value: Record<string, unknown>): AgUiEventEnvelope => ({
      threadId: 'thread', runId: 'run',
      event: { type: EventType.CUSTOM, name: 'tethercode.dev/message-content-chunk', value },
    });
    const previous: AgUiLiveAssistantMessages = {};
    [
      {},
      { canonicalId: 'message', revision: 'r', index: -1, count: 1, data: '{}' },
      { canonicalId: 'message', revision: 'r', index: 1, count: 1, data: '{}' },
      { canonicalId: 'message', revision: 'r', index: 0, count: 1, data: '' },
    ].forEach((value) => expect(updateAgUiLiveAssistantMessages(previous, chunk(value))).toBe(previous));

    let state = updateAgUiLiveAssistantMessages({}, chunk({
      canonicalId: 'message', revision: 'r', index: 0, count: 2, data: '{',
    }));
    state = updateAgUiLiveAssistantMessages(state, chunk({
      canonicalId: 'message', revision: 'r', index: 1, count: 3, data: 'bad',
    }));
    expect(state.thread[0]?.customChunkAssemblies).toBeDefined();
    const pending = updateAgUiLiveAssistantMessages({}, chunk({
      canonicalId: 'message', revision: 'bad-json', index: 0, count: 1, data: '{',
    }));
    expect(pending.thread[0]?.customChunkAssemblies).toBeDefined();

    const payload = JSON.stringify({ messageId: 'message', role: 'thought', content: { type: 'text', text: 'complete' } });
    const complete = updateAgUiLiveAssistantMessages({}, chunk({
      canonicalId: 'message', revision: 'complete', index: 0, count: 1, data: payload,
    }));
    expect(complete.thread[0]).toMatchObject({ text: 'complete', systemKind: 'reasoning' });
    expect(complete.thread[0]?.customChunkAssemblies).toBeUndefined();
  });

  it('covers custom tool fallbacks, duplicate revisions, and generic custom events', () => {
    let state: AgUiLiveAssistantMessages = {};
    const customEvents: AGUIEvent[] = [
      { type: EventType.CUSTOM, name: 'tethercode.dev/message-content', value: { role: 'other', content: { type: 'resourceLink', uri: 'file:///a' } } },
      { type: EventType.CUSTOM, name: 'tethercode.dev/tool-content', value: { content: [{ type: 'text', text: 'structured' }], locations: [] } },
      { type: EventType.CUSTOM, name: 'tethercode.dev/tool-text', value: {} },
      { type: EventType.CUSTOM, name: 'tethercode.dev/tool-text', value: { toolCallId: 'tool', revision: 'one', content: 'first' } },
      { type: EventType.CUSTOM, name: 'tethercode.dev/tool-text', value: { toolCallId: 'tool', revision: 'one', content: 'first' } },
      { type: EventType.CUSTOM, name: 'tethercode.dev/plan', value: { entries: [] } },
      { type: EventType.CUSTOM, name: 'tethercode.dev/unknown', value: 'value' },
    ];
    customEvents.forEach((event) => {
      state = updateAgUiLiveAssistantMessages(state, { threadId: 'thread', runId: 'run', event });
    });
    expect(state.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'run:content', role: 'system', systemKind: 'tool' }),
      expect.objectContaining({ messageId: 'tool:unknown' }),
      expect.objectContaining({ messageId: 'run:custom:tethercode.dev/plan', systemKind: 'reasoning' }),
    ]));
  });

  it('renders every structured content fallback without copied rendering logic', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      [42, '42'],
      [circular, '[content unavailable]'],
      [{ type: 'text', text: '' }, '{"type":"text","text":""}'],
      [{ type: 'image' }, '[image]'],
      [{ type: 'image', image_url: 'image.png' }, '[image: image.png]'],
      [{ type: 'image', data: 'YQ==', mime_type: 'image/png' }, '[image: data:image/png;base64,YQ==]'],
      [{ type: 'audio' }, '[audio]'],
      [{ type: 'audio', mime_type: 'audio/wav' }, '[audio: audio/wav]'],
      [{ type: 'resourceLink', uri: 'file:///a', name: 'A' }, '[file: file:///a] A'],
      [{ type: 'resourceLink', uri: 'file:///a', name: 'file:///a' }, '[file: file:///a]'],
      [{ type: 'resource', resource: {} }, '[resource]'],
      [{ type: 'content', content: { type: 'text', text: 'nested' } }, 'nested'],
      [{ type: 'diff', oldText: 'old', newText: 'new' }, '[diff: file]\nold\nnew'],
      [{ type: 'terminal', terminal_id: 'term', content: 'done' }, '[terminal: term]\ndone'],
      [{ structured_content: [{ type: 'text', text: 'nested' }] }, 'nested'],
      [{ path: 'a.ts', line: 0 }, '[location: a.ts]'],
      [{ path: 'a.ts', line: 2 }, '[location: a.ts:2]'],
    ];
    cases.forEach(([value, expected]) => expect(renderAgUiCustomContent(value)).toBe(expected));
    expect(renderAgUiCustomContent([[[[[[{ type: 'text', text: 'too deep' }]]]]]])).toBe('[[[[[[{"type":"text","text":"too deep"}]]]]]]');
  });
});

describe('CoverageClosure client branches and WS boundary', () => {
  it('covers cache default arguments, misses, clone isolation, and list cache updates', () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    expect(client.peekChats()).toBeNull();
    expect(client.peekAllChats()).toBeNull();
    expect(client.peekChat(' missing ')).toBeNull();
    expect(client.peekChatSummary(' ')).toBeNull();
    expect(client.peekChatSummary('missing')).toBeNull();
    expect(client.peekChatShell('missing')).toBeNull();

    const summary = mapChatSummary({ id: 'thread', preview: 'cached', updatedAt: 2 }) as ChatSummary;
    client.rememberAllChats([summary]);
    client.rememberChats([summary]);
    expect(client.peekChatSummary('thread')).toEqual(summary);
    expect(client.peekChatShell('thread')).toMatchObject({ id: 'thread', messages: [] });
    const chat = mapChat({ id: 'thread', name: 'full', updatedAt: 3, turns: [] });
    client.rememberChat(chat);
    expect(client.peekChatSummary('thread')?.title).toBe('full');
    expect(client.peekChats()?.[0]?.title).toBe('full');
    expect(client.peekAllChats()?.[0]?.title).toBe('full');
    const cloned = client.peekChat('thread') as Chat;
    cloned.title = 'mutated';
    expect(client.peekChat('thread')?.title).toBe('full');
    client.rememberChats([]);
  });

  it('covers list defaults, cursor variants, diagnostics filtering, and in-flight caching', async () => {
    const ws = createWsMock();
    let resolveList: (value: unknown) => void = () => {};
    ws.request.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const first = client.listChats({ cacheTtlMs: -1, limit: Number.NaN });
    const second = client.listChats({ cacheTtlMs: -1, limit: Number.NaN });
    resolveList({ data: [null, {}, { id: 'thread', updatedAt: 2 }], next_cursor: ' next ', backwards_cursor: ' back ', diagnostics: [null, 'warning'], partial: false });
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(ws.request).toHaveBeenCalledTimes(1);
    await expect(client.listChats({ cacheTtlMs: 1000, limit: Number.NaN })).resolves.toHaveLength(1);
    expect(ws.request).toHaveBeenCalledTimes(1);

    ws.request.mockResolvedValueOnce({ data: [], nextCursor: null });
    await client.primeChats();
    ws.request.mockResolvedValueOnce({ data: [], nextCursor: null });
    await client.listAllChats();
    expect(client.peekAllChats()).toEqual([]);
  });

  it('covers stream defaults, ignored events, backend errors, invalid starts, and cancel rejection', async () => {
    const ws = createWsMock();
    type Handler = Parameters<HostBridgeWsClient['onEvent']>[0];
    let handler: Handler = () => {};
    const unsubscribe = jest.fn();
    ws.onEvent.mockImplementation((next) => { handler = next; return unsubscribe; });
    ws.request.mockImplementation((method, params) => {
      if (method === 'bridge/thread/list/stream/start') {
        return Promise.resolve({ started: true, streamId: (params as { streamId: string }).streamId });
      }
      if (method === 'bridge/thread/list/stream/cancel') return Promise.reject(new Error('closed'));
      return Promise.resolve({});
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const batches: unknown[] = [];
    const errors: Error[] = [];
    const controller = await client.startChatListStream({ limits: [], delayMs: Number.NaN }, (batch) => batches.push(batch), (error) => errors.push(error));
    handler({ method: 'other', params: null });
    handler({ method: 'other', params: { streamId: 'other' } });
    handler({ method: 'other', params: { streamId: controller.streamId } });
    handler({ method: 'bridge/thread/list/stream/batch', params: { streamId: controller.streamId, limit: 'bad', data: 'bad', done: false } });
    expect(batches).toHaveLength(1);
    handler({ method: 'bridge/thread/list/stream/error', params: { streamId: controller.streamId } });
    expect(errors[0]?.message).toBe('thread list stream failed');
    controller.cancel();

    const invalidWs = createWsMock();
    invalidWs.request.mockResolvedValue({ started: false, streamId: 'wrong' });
    const invalidClient = new HostBridgeApiClient({ ws: invalidWs as unknown as HostBridgeWsClient });
    await expect(invalidClient.startChatListStream({ includeSubAgents: true, limits: [0, 0, 500], delayMs: -2 }, () => {})).rejects.toThrow('did not start');
  });

  it('merges snapshot pages across replacement, new kinds, metadata, and revision errors', () => {
    const snapshot = makeSnapshot({
      timeline: [{ sequence: 2, kind: 'message', canonicalId: 'old' }],
      messages: [{ id: 'old', role: 'agent', parts: [], truncated: false }],
      tools: [],
      messageCollection: { truncated: true, omittedCount: 2, revision: 4 },
      reasoningCollection: { truncated: true, omittedCount: 1, revision: 4 },
      toolCollection: { truncated: true, omittedCount: 1, revision: 4 },
      continuation: { revision: 4, unavailableCount: 1, maxPageSize: 50, maxHistoryEntries: 100, maxHistoryBytes: 1000 },
    });
    expect(() => mergeSnapshotPage(snapshot, {
      entries: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false,
      unavailableCount: 0, earliestAvailableSequence: null, latestAvailableSequence: null, revision: 5,
    })).toThrow(StaleSnapshotRevisionError);

    const merged = mergeSnapshotPage(snapshot, {
      entries: [
        { sequence: 2, kind: 'message', canonicalId: 'new', message: { id: 'new', role: 'agent', parts: [], truncated: false } },
        { sequence: 1, kind: 'reasoning', canonicalId: 'reason', message: { id: 'reason', role: 'thought', parts: [], truncated: false } },
        { sequence: 3, kind: 'tool', canonicalId: 'tool', tool: { id: 'tool', kind: 'read', status: 'done', title: '', content: '', structuredContent: [], locations: [], truncated: false } },
      ],
      beforeCursor: 'before', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false,
      unavailableCount: 2, earliestAvailableSequence: 1, latestAvailableSequence: 3, revision: 4,
    });
    expect(merged.timeline?.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(merged.reasoningCollection?.omittedCount).toBe(0);
    expect(merged.toolCollection?.beforeCursor).toBe('before');
  });

  it('normalizes list, snapshot page, workspace, filesystem, and browser response variants', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        entries: [
          null,
          { sequence: 'bad', kind: 'message', canonicalId: 'bad' },
          { sequence: 1, kind: 'bad', canonicalId: 'bad' },
          { sequence: 2, kind: 'message', canonicalId: ' message ', message: { parts: 'bad' } },
          { sequence: 3, kind: 'tool', canonicalId: 'tool', tool: { generation: 2, structuredContent: 'bad', locations: 'bad' } },
        ],
        beforeCursor: 4, afterCursor: 'after', hasMoreAfter: true, unavailableCount: 'bad', revision: 2,
      })
      .mockResolvedValueOnce({
        bridgeRoot: '/repo', allowOutsideRootCwd: true,
        workspaces: [null, { path: '' }, { path: '/one', chatCount: -2, updatedAt: 1700000000 }, { path: '/two', chatCount: '3', updatedAt: 'bad' }],
      })
      .mockResolvedValueOnce({
        bridgeRoot: '/repo', path: '/repo', parentPath: '', totalEntries: '2', omittedEntries: -1,
        entries: [null, { path: '', name: '' }, { path: '/repo/a', name: 'a', kind: 3, hidden: true, selectable: false, isGitRepo: true }],
      })
      .mockResolvedValueOnce({ sessions: [null, {}, {
        sessionId: 'one', targetUrl: 'http://localhost:3000', previewPort: '3000', previewBaseUrl: '',
        bootstrapPath: '/preview', createdAt: 1700000000, lastAccessedAt: 'bad', expiresAt: 1700000100,
      }] })
      .mockResolvedValueOnce({ scannedAt: 'bad', suggestions: [null, {}, { targetUrl: 'http://localhost:4', label: 'Dev', port: '4' }] });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    const page = await client.readSnapshotPage({ threadId: 'thread', afterCursor: 'after', limit: 0 });
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/snapshot/page', {
      threadId: 'thread', beforeCursor: null, afterCursor: 'after', revision: undefined, limit: 0,
    });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]?.message).toMatchObject({ id: 'message', role: '', parts: [] });
    expect(page.entries[1]?.tool).toMatchObject({ id: 'tool', generation: 2, structuredContent: [] });

    expect((await client.listWorkspaceRoots()).workspaces).toEqual([
      expect.objectContaining({ path: '/one', chatCount: 0 }),
      expect.objectContaining({ path: '/two', chatCount: 3 }),
    ]);
    expect((await client.listFilesystemEntries({ path: ' /repo ', includeHidden: true, directoriesOnly: false, includeGitRepo: true })).entries[0]).toMatchObject({
      kind: 'directory', hidden: true, selectable: false, isGitRepo: true,
    });
    expect(await client.listBrowserPreviewSessions()).toEqual([
      expect.objectContaining({ sessionId: 'one', previewPort: 3000, lastAccessedAt: '2023-11-14T22:13:20.000Z' }),
    ]);
    expect((await client.discoverBrowserPreviewTargets()).suggestions).toEqual([
      { targetUrl: 'http://localhost:4', label: 'Dev', port: 4 },
    ]);
  });

  it('normalizes creation, resume, steer, queue, and interruption request payloads', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ thread: { id: 'created', createdAt: 1700000000 } })
      .mockResolvedValueOnce({ model: ' resumed ', reasoning_effort: 'HIGH' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ threadId: 'thread', items: [], pendingSteers: [], pendingSteerCount: 0, waitingForToolCalls: false, steeringInFlight: false, lastError: null })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ thread: { id: 'thread', turns: [{ id: '', status: 'running' }, { id: 'done', status: 'completed' }, { id: 'active', status: 'queued' }] } })
      .mockResolvedValueOnce({});
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await client.createChat({
      message: ' ',
      agentId: ' agent ',
      cwd: ' /repo ',
      model: ' model ',
      effort: 'HIGH' as never,
      serviceTier: 'FAST' as never,
      approvalPolicy: 'NEVER' as never,
    });
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/start', expect.objectContaining({
      agentId: 'agent', cwd: '/repo', model: 'model', approvalPolicy: 'never', config: { service_tier: 'fast' },
    }));
    await expect(
      client.resumeThread(' thread ', {
        model: ' ',
        cwd: ' ',
        approvalPolicy: 'invalid' as never,
      })
    ).rejects.toThrow('canonical workspace path');
    await expect(
      client.resumeThread(' thread ', {
        model: ' ',
        cwd: ' /repo ',
        approvalPolicy: 'invalid' as never,
      })
    ).resolves.toEqual({ model: 'resumed', effort: 'high' });
    await client.steerChatTurn(' thread ', ' turn ', {
      content: ' steer ',
      mentions: [{ name: ' ', path: ' src/a.ts ' }, { name: 'duplicate', path: 'SRC/A.TS' }, { name: 'bad', path: ' ' }],
      localImages: [{ path: ' /tmp/a.png ' }, { path: '/TMP/A.PNG' }, { path: '' }],
    });
    expect(ws.request).toHaveBeenNthCalledWith(3, 'turn/steer', {
      threadId: 'thread', expectedTurnId: 'turn',
      input: [
        { type: 'text', text: 'steer', text_elements: [] },
        { type: 'mention', name: 'a.ts', path: 'src/a.ts' },
        { type: 'localImage', path: '/tmp/a.png' },
      ],
    });
    await expect(client.readThreadQueue(' ')).resolves.toMatchObject({ threadId: '', items: [] });
    await client.readThreadQueue(' thread ');
    await expect(client.steerChatTurn('', 'turn', { content: 'x' })).resolves.toBeUndefined();
    await expect(client.interruptTurn('', 'turn')).rejects.toThrow('required');
    await client.interruptTurn(' thread ', ' turn ');
    await expect(client.interruptLatestTurn(' ')).rejects.toThrow('threadId is required');
    await expect(client.interruptLatestTurn('thread')).resolves.toBe('active');
    expect(ws.request).toHaveBeenLastCalledWith('turn/interrupt', { threadId: 'thread', turnId: 'active' });
  });

  it('covers browser validation, close results, create failures, and workspace validation', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ closed: false })
      .mockResolvedValueOnce({ thread: {} })
      .mockResolvedValueOnce({ thread: null });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.createBrowserPreviewSession('http://localhost')).rejects.toThrow('invalid session');
    await expect(client.closeBrowserPreviewSession('session')).resolves.toBe(false);
    await expect(client.createChat({ message: '' })).rejects.toThrow('chat id');
    await expect(client.createChatIdempotent({ message: '' }, 'submission')).rejects.toThrow('did not return a chat');
    await expect(client.setChatWorkspace('thread', ' ')).rejects.toThrow('cannot be empty');
    ws.request.mockResolvedValueOnce({});
    ws.request.mockResolvedValueOnce({ thread: { id: 'thread', cwd: '/other' } });
    await expect(client.setChatWorkspace('thread', ' /repo ')).resolves.toMatchObject({ cwd: '/repo' });
  });

  it('covers empty sends, role validation, queue failures, and missing turn ids', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ thread: { id: 'thread', turns: [] } })
      .mockResolvedValueOnce({ model: null, effort: null })
      .mockResolvedValueOnce({ turn: {} })
      .mockResolvedValueOnce({ threadId: 'thread', items: [], pendingSteers: [], pendingSteerCount: 0, waitingForToolCalls: false, steeringInFlight: false, lastError: null })
      .mockResolvedValueOnce({ thread: { id: 'thread', turns: [] } })
      .mockResolvedValueOnce({ model: null, effort: null })
      .mockResolvedValueOnce({ disposition: 'sent', turnId: ' ', queue: { threadId: 'thread', items: [] } });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.sendChatMessage('thread', { content: ' ' })).resolves.toMatchObject({ id: 'thread' });
    await expect(client.sendChatMessage('thread', { content: 'x', role: 'assistant' })).rejects.toThrow('Only user role');
    await expect(
      client.sendChatMessage('thread', { content: 'x', cwd: '/workspace' })
    ).rejects.toThrow('turn id');
    const empty = await client.sendOrQueueChatMessage('thread', { content: ' ' });
    expect(empty).toMatchObject({ disposition: 'sent', turnId: '' });
    await expect(
      client.sendOrQueueChatMessage('thread', { content: 'x', cwd: '/workspace' })
    ).rejects.toThrow('did not return turn id');
  });

  it('covers malformed public response defaults and option normalizers', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: 'bad' })
      .mockResolvedValueOnce({ workspaces: 'bad' })
      .mockResolvedValueOnce({ entries: 'bad' })
      .mockResolvedValueOnce({ suggestions: 'bad' })
      .mockResolvedValueOnce({ sessions: 'bad' });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.readSnapshotPage({ threadId: 'thread' })).resolves.toMatchObject({ entries: [], revision: 0, unavailableCount: 0 });
    await expect(client.listWorkspaceRoots(3)).resolves.toMatchObject({ bridgeRoot: '', workspaces: [] });
    await expect(client.listFilesystemEntries()).resolves.toMatchObject({ bridgeRoot: '', path: '', entries: [] });
    await expect(client.discoverBrowserPreviewTargets()).resolves.toMatchObject({ suggestions: [] });
    await expect(client.listLoadedChatIds()).resolves.toEqual([]);
    await expect(client.listWorkspaceRoots()).resolves.toMatchObject({ workspaces: [] });
    await expect(client.listFilesystemEntries()).resolves.toMatchObject({ entries: [] });
    await expect(client.discoverBrowserPreviewTargets()).resolves.toMatchObject({ suggestions: [] });
    await expect(client.listBrowserPreviewSessions()).resolves.toEqual([]);
  });

  it('covers list cache lookup order, all-list caching, and default stream options', async () => {
    const ws = createWsMock();
    type Handler = Parameters<HostBridgeWsClient['onEvent']>[0];
    let handler: Handler = () => {};
    ws.onEvent.mockImplementation((next) => { handler = next; return jest.fn(); });
    ws.request.mockImplementation((method, params) => {
      if (method === 'bridge/thread/list/stream/start') return Promise.resolve({ started: true, streamId: (params as { streamId: string }).streamId });
      return Promise.resolve({ data: [] });
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const summary = mapChatSummary({ id: 'thread', updatedAt: 1 }) as ChatSummary;
    client.rememberChats([summary], { includeSubAgents: true, limit: 50 });
    expect(client.peekChatSummary('thread')).toEqual(summary);
    const other = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    other.rememberAllChats([summary], { includeSubAgents: true });
    expect(other.peekChatSummary('thread')).toEqual(summary);
    await other.listAllChats({ includeSubAgents: true, cacheTtlMs: 1000 });
    const controller = await client.startChatListStream({}, () => {});
    handler({ method: 'bridge/thread/list/stream/batch', params: { streamId: controller.streamId, data: [], done: true } });
    controller.cancel();
  });

  it('covers summary cache updates, workspace equality, queued idempotence, and collaboration fallbacks', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ thread: { id: 'thread', name: 'remote', cwd: '/repo' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ thread: { id: 'thread', cwd: '/repo' } })
      .mockResolvedValueOnce({ model: 'model', reasoningEffort: 'medium' })
      .mockResolvedValueOnce({ disposition: 'queued', queue: { threadId: 'thread', items: [] } })
      .mockResolvedValueOnce({ thread: { id: 'thread' } })
      .mockResolvedValueOnce({ model: null, effort: null })
      .mockResolvedValueOnce({ turn: { id: 'turn' } })
      .mockResolvedValueOnce({ thread: { id: 'thread', turns: [{ id: 'turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] }] } });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    client.rememberChat(mapChat({ id: 'thread', name: 'cached', turns: [{ items: [{ type: 'agentMessage', text: 'old' }] }] }));
    await expect(client.getChatSummary('thread')).resolves.toMatchObject({ title: 'remote' });
    await expect(client.setChatWorkspace('thread', '/repo')).resolves.toMatchObject({ cwd: '/repo' });
    const callback = jest.fn();
    await expect(
      client.sendChatMessageIdempotent(
        'thread',
        { content: 'queued', cwd: '/repo' },
        'submission',
        { onTurnStarted: callback }
      )
    ).resolves.toMatchObject({ id: 'thread' });
    expect(callback).not.toHaveBeenCalled();
    await expect(
      client.sendChatMessage('thread', {
        content: 'hello',
        cwd: '/repo',
        collaborationMode: 'ask' as never,
        model: 'model',
        effort: 'invalid' as never,
        agent: ' ',
      })
    ).resolves.toMatchObject({ id: 'thread' });
  });

  it('covers remaining public client defaults, cache expiry, and sent idempotence', async () => {
    const ws = createWsMock();
    ws.onEvent.mockImplementation(() => jest.fn());
    ws.request.mockImplementation((method, params) => {
      if (method === 'bridge/thread/list/stream/start') return Promise.resolve({ started: true, streamId: (params as { streamId: string }).streamId });
      if (method === 'thread/list') return Promise.resolve({ data: 'bad' });
      if (method === 'thread/read') return Promise.resolve({ thread: { id: 'thread', turns: [{ id: 'turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'sent' }] }] }] } });
      if (method === 'thread/resume') return Promise.resolve({ model: 'model', effort: 'low' });
      if (method === 'bridge/thread/queue/send') return Promise.resolve({ disposition: 'sent', turnId: 'turn', queue: { threadId: 'thread', items: [] } });
      return Promise.resolve({});
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.startChatListStream(undefined as never, () => {});
    await expect(client.listChats({ includeSubAgents: true, forceRefresh: true })).resolves.toEqual([]);
    await expect(client.listAllChats({ includeSubAgents: false, forceRefresh: true })).resolves.toMatchObject({ chats: [] });

    const summary = mapChatSummary({ id: 'thread', updatedAt: 1 }) as ChatSummary;
    client.rememberChats([summary]);
    client.rememberAllChats([summary]);
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(1000);
    client.rememberChats([summary], { limit: 9 });
    client.rememberAllChats([summary], { includeSubAgents: true });
    await client.listChats({ limit: 9, cacheTtlMs: 1 });
    await client.listAllChats({ includeSubAgents: true, cacheTtlMs: 1 });
    now.mockRestore();

    await client.gitHistory('/repo');
    await client.gitStageAll();
    await client.gitUnstageAll();
    await client.gitPush();
    await client.installGitHubAuth({ accessToken: 'token' });
    const started = jest.fn();
    await expect(
      client.sendChatMessageIdempotent(
        'thread',
        { content: 'sent', cwd: '/workspace', collaborationMode: 'plan', model: 'model' },
        'submission',
        { onTurnStarted: started }
      )
    ).resolves.toMatchObject({ id: 'thread' });
    expect(started).toHaveBeenCalledWith('turn');
  });

  it('covers message reconciliation with malformed and attachment-bearing turn content', async () => {
    jest.useFakeTimers();
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ model: 'model', effort: 'medium' })
      .mockResolvedValueOnce({ turn: { id: 'turn' } })
      .mockResolvedValue({
        thread: {
          id: 'thread',
          turns: [{ id: 'turn', items: [
            null,
            { type: 'agentMessage' },
            { type: 'userMessage', content: 'bad' },
            { type: 'userMessage', content: [null, { type: 'text', text: 3 }, { type: 'mention', path: '' }, { type: 'localImage', path: '' }] },
            { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'mention', path: 'src/a.ts' }, { type: 'localImage', path: '/tmp/a.png' }] },
          ] }],
        },
      });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const promise = client.sendChatMessage('thread', {
      content: 'hello',
      cwd: '/workspace',
      mentions: [{ path: 'src/a.ts', name: '' }],
      localImages: [{ path: '/tmp/a.png' }],
      collaborationMode: 'default',
    });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ id: 'thread' });
    jest.useRealTimers();
  });

  it('closes remaining client DTO, normalization, cache, and null-cwd branches', async () => {
    const merged = mergeSnapshotPage(makeSnapshot({ timeline: undefined, continuation: undefined }), {
      entries: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false,
      unavailableCount: 0, earliestAvailableSequence: null, latestAvailableSequence: null, revision: 1,
    });
    expect(merged).toMatchObject({ timeline: [], continuation: undefined });

    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        entries: [{
          sequence: 1, kind: 'tool', canonicalId: 'tool',
          tool: { id: 'tool', structuredContent: [{ type: 'text', text: 'ok' }], locations: [{ path: 'a.ts' }] },
        }],
      })
      .mockResolvedValueOnce({
        workspaces: [
          { path: '/blank', chatCount: 'bad', updatedAt: ' ' },
          { path: '/milliseconds', updatedAt: 1700000000000 },
          { path: '/date', updatedAt: '2026-01-01T00:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({
        sessions: [{
          sessionId: 'session', targetUrl: 'https://example.com', bootstrapPath: '/preview',
          previewPort: 'bad', createdAt: 1700000000, expiresAt: 1700000001,
        }],
      })
      .mockResolvedValueOnce({
        suggestions: [{ targetUrl: 'https://example.com', label: 'bad', port: 'bad' }],
      });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    expect((await client.readSnapshotPage({ threadId: 'thread' })).entries[0]?.tool).toMatchObject({
      structuredContent: [{ type: 'text', text: 'ok' }], locations: [{ path: 'a.ts' }],
    });
    expect((await client.listWorkspaceRoots()).workspaces).toEqual([
      { path: '/blank', chatCount: 0 },
      expect.objectContaining({ path: '/milliseconds', updatedAt: '2023-11-14T22:13:20.000Z' }),
      expect.objectContaining({ path: '/date', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(await client.listBrowserPreviewSessions()).toEqual([
      expect.objectContaining({ sessionId: 'session', previewPort: 1 }),
    ]);
    expect((await client.discoverBrowserPreviewTargets()).suggestions).toEqual([
      { targetUrl: 'https://example.com', label: 'bad', port: 1 },
    ]);

    ws.request.mockResolvedValue({ ok: true });
    await client.gitStage({ path: 'a.ts' });
    await client.gitUnstage({ path: 'a.ts' });
    await client.gitCommit({ message: 'message' });
    await client.gitSwitch({ branch: 'main' });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/stage', { path: 'a.ts', cwd: null });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/commit', { message: 'message', cwd: null });

    const cached = mapChat({ id: 'cached', turns: [] });
    client.rememberChat(cached);
    await expect(client.getChat('cached', { cacheTtlMs: 1000 })).resolves.toMatchObject({ id: 'cached' });
    client.rememberAllChats([cached]);
    await expect(client.listAllChats({ cacheTtlMs: 1000 })).resolves.toMatchObject({ chats: [expect.objectContaining({ id: 'cached' })] });
    await expect(client.getChatSummaries([3 as never, ' ', 'one', 'one'], { concurrency: Number.NaN })).resolves.toEqual([]);

    const createWs = createWsMock();
    createWs.request.mockResolvedValue({ thread: { id: 'created' } });
    const createClient = new HostBridgeApiClient({ ws: createWs as unknown as HostBridgeWsClient });
    for (const effort of ['none', 'minimal', 'low', 'medium', 'xhigh', 'invalid']) {
      await createClient.createChat({ message: '', effort: effort as never, serviceTier: effort === 'none' ? 'flex' : undefined });
    }
    expect(createWs.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ config: { service_tier: 'flex' } }));

    const sendWs = createWsMock();
    sendWs.request.mockImplementation((method) => {
      if (method === 'thread/resume') return Promise.resolve({ model: null, effort: null });
      if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn' } });
      return Promise.resolve({ thread: { id: 'thread', turns: [{ id: 'turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] }] } });
    });
    const sendClient = new HostBridgeApiClient({ ws: sendWs as unknown as HostBridgeWsClient });
    for (const collaborationMode of ['invalid', 'ask', 'plan']) {
      await sendClient.sendChatMessage('thread', {
        content: 'hello',
        cwd: '/workspace',
        collaborationMode: collaborationMode as never,
      });
    }
    expect(sendWs.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ collaborationMode: null }));
  });

  it('covers final cache hits, null session response, malformed interrupt state, and deep clones', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ thread: { id: 'thread', turns: 'bad' } });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.listBrowserPreviewSessions()).resolves.toEqual([]);
    await expect(client.interruptLatestTurn('thread')).resolves.toBeNull();

    const chat = mapChat({ id: 'cached', turns: [] });
    chat.messages = [
      {
        id: 'with-meta', role: 'system', content: 'meta', createdAt: chat.createdAt,
        subAgentMeta: { tool: 'spawnAgent', receiverThreadIds: ['child'] },
      },
      {
        id: 'without-receivers', role: 'system', content: 'meta', createdAt: chat.createdAt,
        subAgentMeta: { tool: 'wait' },
      },
      { id: 'plain', role: 'assistant', content: 'plain', createdAt: chat.createdAt },
    ];
    client.rememberChat(chat);
    expect(client.peekChatShell('cached')).toMatchObject({ id: 'cached' });
    await expect(client.getChat('cached', { cacheTtlMs: 1000 })).resolves.toMatchObject({ id: 'cached' });
    const clone = client.peekChat('cached') as Chat;
    clone.messages[0].subAgentMeta?.receiverThreadIds?.push('mutated');
    expect(client.peekChat('cached')?.messages[0].subAgentMeta?.receiverThreadIds).toEqual(['child']);

    client.rememberAllChats([chat]);
    await expect(client.listAllChats({ cacheTtlMs: 1000 })).resolves.toMatchObject({
      chats: [expect.objectContaining({ id: 'cached' })],
    });
  });

  it('covers isolated summary cache matches and repeated progressing cursors', async () => {
    const ws = createWsMock();
    const summary = mapChatSummary({ id: 'thread', updatedAt: 1 }) as ChatSummary;
    const listClient = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    listClient.rememberChats([summary]);
    expect(listClient.peekChatSummary('thread')).toEqual(summary);

    const allListClient = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    allListClient.rememberAllChats([summary]);
    expect(allListClient.peekChatSummary('thread')).toEqual(summary);

    ws.request
      .mockResolvedValueOnce({ data: [{ id: 'one', updatedAt: 1 }], nextCursor: 'repeat' })
      .mockResolvedValueOnce({ data: [{ id: 'two', updatedAt: 2 }], nextCursor: 'repeat' });
    const result = await new HostBridgeApiClient({
      ws: ws as unknown as HostBridgeWsClient,
    }).listAllChats({ forceRefresh: true });
    expect(result).toMatchObject({ partial: true });
    expect(result.diagnostics).toContain('Chat listing repeated a page cursor.');
  });

  it('uses the sub-agent default page limit and serves a fresh all-list cache', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ data: [], nextCursor: null });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.listAllChats({ includeSubAgents: true, forceRefresh: true });
    expect(ws.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ limit: 50 }));

    const summary = mapChatSummary({ id: 'cached', updatedAt: 1 }) as ChatSummary;
    client.rememberAllChats([summary]);
    ws.request.mockClear();
    await expect(client.listAllChats({ cacheTtlMs: 1000 })).resolves.toMatchObject({
      chats: [expect.objectContaining({ id: 'cached' })],
    });
    expect(ws.request).not.toHaveBeenCalled();
  });

  it('ignores a turn whose normalized status is empty', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      thread: { id: 'thread', turns: [{ id: 'turn', status: ' ' }] },
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.interruptLatestTurn('thread')).resolves.toBeNull();
  });

  it('tests attachment parsing and public RPC pass-through boundaries', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ ok: true });
    const withoutUrl = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(withoutUrl.uploadAttachment({ uri: 'file:///a', kind: 'image' })).rejects.toThrow('Bridge URL');

    const uploadAsync = FileSystem.uploadAsync as jest.MockedFunction<typeof FileSystem.uploadAsync>;
    const client = new HostBridgeApiClient({
      ws: ws as unknown as HostBridgeWsClient,
      bridgeUrl: 'https://bridge.example/',
      authToken: ' token ',
    });
    uploadAsync.mockResolvedValueOnce({ status: 200, body: '{"id":"attachment"}', headers: {} } as never);
    await expect(client.uploadAttachment({
      uri: 'file:///a', kind: 'image', fileName: ' a.png ', mimeType: ' image/png ', threadId: ' thread ',
    })).resolves.toMatchObject({ id: 'attachment' });
    expect(uploadAsync).toHaveBeenCalledWith('https://bridge.example/attachments', 'file:///a', expect.objectContaining({
      parameters: { kind: 'image', fileName: 'a.png', mimeType: 'image/png', threadId: 'thread' },
      headers: { Authorization: 'Bearer token' },
    }));

    uploadAsync.mockResolvedValueOnce({ status: 400, body: '{"message":"too large"}', headers: {} } as never);
    await expect(client.uploadAttachment({ uri: 'file:///a', kind: 'file' })).rejects.toThrow('too large');
    uploadAsync.mockResolvedValueOnce({ status: 500, body: 'not json', headers: {} } as never);
    await expect(client.uploadAttachment({ uri: 'file:///a', kind: 'file' })).rejects.toThrow('Attachment upload failed (500)');

    await client.readBridgeCapabilities();
    await client.registerPushDevice({ profileId: 'p', registrationId: 'r', token: 't', platform: 'ios', deviceName: 'phone', events: { turnCompleted: true, approvalRequested: false } });
    await client.unregisterPushDevice({ profileId: 'p', registrationId: 'r' });
    await client.listApprovals();
    await client.resolveApproval('a', 'accept', 'resolution');
    await client.resolveUserInput('u', { answers: { q: 'a' }, action: 'submit' });
    await client.resolveBridgeUiSurface('surface', { threadId: 'thread', actionId: 'ok' });
    await client.dismissBridgeUiSurface('surface');
    await client.execTerminal({ command: 'pwd' });
    expect(ws.request).toHaveBeenCalledWith('bridge/capabilities/read');
    expect(ws.request).toHaveBeenCalledWith('bridge/ui/dismiss', { id: 'surface', threadId: null });
    expect(ws.request).toHaveBeenCalledWith('bridge/terminal/exec', { command: 'pwd' });
  });

  it('covers git validation and normalized request boundaries', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ ok: true });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await expect(client.installGitHubAuth({ accessToken: ' ', repositories: [] })).rejects.toThrow('grant');
    await client.installGitHubAuth({ grants: [
      { accessToken: ' token ', repositories: [' repo ', ' '] },
      { accessToken: ' ', repositories: [] },
    ] });
    await expect(client.gitClone({ url: ' ', parentPath: '/tmp', directoryName: 'x' })).rejects.toThrow('url');
    await expect(client.gitClone({ url: 'url', parentPath: '/tmp', directoryName: ' ' })).rejects.toThrow('directoryName');
    await client.gitClone({ url: ' url ', parentPath: ' ', directoryName: ' repo ' });
    await expect(client.gitStage({ path: ' ' })).rejects.toThrow('path');
    await expect(client.gitUnstage({ path: ' ' })).rejects.toThrow('path');
    await expect(client.gitSwitch({ branch: ' ' })).rejects.toThrow('branch');
    await client.gitStage({ path: ' a.ts ', cwd: ' /repo ' });
    await client.gitUnstage({ path: ' a.ts ', cwd: '' });
    await client.gitStatus();
    await client.gitDiff(' /repo ');
    await client.gitHistory('', 3);
    await client.gitBranches();
    await client.gitStageAll('/repo');
    await client.gitUnstageAll();
    await client.gitCommit({ message: 'message', cwd: ' /repo ' });
    await client.gitSwitch({ branch: ' main ', cwd: '/repo' });
    await client.gitPush();
    expect(ws.request).toHaveBeenCalledWith('bridge/github/auth/install', {
      grants: [{ accessToken: 'token', repositories: ['repo'] }],
    });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/clone', { url: 'url', parentPath: null, directoryName: 'repo' });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/switch', { branch: 'main', cwd: '/repo' });
  });
});