import type {
  Chat,
  ChatMessage,
  ChatSummary,
  ChatStatus,
  PendingUserInputRequest,
} from '../../api/types';
import * as helpers from '../mainScreenHelpers';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  createdAt = '2026-07-18T12:00:00.000Z'
): ChatMessage {
  return { id, role, content, createdAt };
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'thread-1',
    title: 'Thread',
    status: 'idle',
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
    statusUpdatedAt: '2026-07-18T12:00:00.000Z',
    lastMessagePreview: '',
    messages: [],
    ...overrides,
  } as Chat;
}

function summary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'thread-1',
    title: 'Thread',
    status: 'idle',
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
    statusUpdatedAt: '2026-07-18T12:00:00.000Z',
    lastMessagePreview: '',
    ...overrides,
  };
}

const plan = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  explanation: 'Explain',
  steps: [{ step: 'Test', status: 'pending' as const }],
  deltaText: 'delta',
  updatedAt: '2026-07-18T12:00:00.000Z',
};

describe('mainScreenHelpers branch behavior', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
  });

  it('schedules and cancels idle work with and without idle callback support', () => {
    const task = jest.fn();
    const cancelIdleCallback = jest.fn();
    const requestIdleCallback = jest.fn(() => 17);
    Object.assign(globalThis, { requestIdleCallback, cancelIdleCallback });
    helpers.scheduleIdleTask(task, 123).cancel();
    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 123 });
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);

    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    helpers.scheduleIdleTask(task).cancel();

    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    jest.useFakeTimers();
    const fallback = helpers.scheduleIdleTask(task);
    fallback.cancel();
    jest.runAllTimers();
    expect(task).not.toHaveBeenCalled();
  });

  it('reads primitive payload values defensively', () => {
    expect(helpers.toRecord({ ok: true })).toEqual({ ok: true });
    expect(helpers.toRecord(null)).toBeNull();
    expect(helpers.toRecord('x')).toBeNull();
    expect(helpers.readString('x')).toBe('x');
    expect(helpers.readString(1)).toBeNull();
    expect(helpers.readStringArray('x')).toBeNull();
    expect(helpers.readStringArray([1, 'a', false])).toEqual(['a']);
    expect(helpers.readStringArray([1])).toBeNull();
    expect(helpers.readNumber(2)).toBe(2);
    expect(helpers.readNumber(Number.NaN)).toBeNull();
    expect(helpers.readIntegerLike(3.9)).toBe(3);
    expect(helpers.readIntegerLike(-2)).toBe(0);
    expect(helpers.readIntegerLike(' 4.8 ')).toBe(4);
    expect(helpers.readIntegerLike('')).toBeNull();
    expect(helpers.readIntegerLike('wat')).toBeNull();
    expect(helpers.readBoolean(false)).toBe(false);
    expect(helpers.readBoolean('false')).toBeNull();
  });

  it('merges context usage and plan deltas across matching turns', () => {
    const previousUsage = {
      totalTokens: 10,
      lastTokens: 2,
      modelContextWindow: 100,
      updatedAtMs: 1,
    };
    expect(helpers.mergeThreadContextUsage(previousUsage, null)).toBe(previousUsage);
    expect(
      helpers.mergeThreadContextUsage(previousUsage, {
        totalTokens: null,
        lastTokens: 3,
        modelContextWindow: null,
        updatedAtMs: 2,
      })
    ).toEqual({ totalTokens: 10, lastTokens: 3, modelContextWindow: 100, updatedAtMs: 2 });
    expect(
      helpers.mergeThreadContextUsage(null, {
        totalTokens: null,
        lastTokens: null,
        modelContextWindow: null,
        updatedAtMs: 3,
      })
    ).toEqual({ totalTokens: null, lastTokens: null, modelContextWindow: null, updatedAtMs: 3 });

    expect(helpers.compactPlanDelta('  one\n\n two ')).toBe('one\ntwo');
    expect(helpers.compactPlanDelta('x'.repeat(1300))).toHaveLength(1200);
    expect(helpers.buildNextPlanStateFromDelta(plan, 'thread-1', 'turn-1', 'next')).toMatchObject({
      explanation: 'Explain',
      steps: plan.steps,
      deltaText: 'delta\nnext',
    });
    expect(helpers.buildNextPlanStateFromDelta(plan, 'thread-1', 'turn-2', 'next')).toMatchObject({
      explanation: null,
      steps: [],
      deltaText: 'next',
    });
    expect(
      helpers.buildNextPlanStateFromUpdate(plan, {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: null,
        plan: [],
      }).deltaText
    ).toBe('delta');
    expect(
      helpers.buildNextPlanStateFromUpdate(plan, {
        threadId: 'thread-2',
        turnId: 'turn-1',
        explanation: null,
        plan: [],
      }).deltaText
    ).toBe('');
    expect(helpers.renderPlanStatusGlyph('completed')).toBe('✔');
    expect(helpers.renderPlanStatusGlyph('inProgress')).toBe('□');
    expect(helpers.renderPlanStatusGlyph('pending')).toBe('□');
  });

  it('parses plan updates and turn id fallbacks', () => {
    expect(helpers.toTurnPlanUpdate(null)).toBeNull();
    expect(helpers.toTurnPlanUpdate({ turnId: 't' })).toBeNull();
    expect(helpers.toTurnPlanUpdate({ threadId: 'x' })).toBeNull();
    expect(
      helpers.toTurnPlanUpdate({
        turnId: 't',
        explanation: 3,
        plan: [null, {}, { step: '', status: 'pending' }, { step: 'bad', status: 'bad' }, { step: 'ok', status: 'completed' }],
      }, 'fallback')
    ).toEqual({
      threadId: 'fallback',
      turnId: 't',
      explanation: null,
      plan: [{ step: 'ok', status: 'completed' }],
    });
  });

  it('parses user input requests, explicit options, and inline options', () => {
    expect(helpers.toPendingUserInputRequest(null)).toBeNull();
    expect(helpers.toPendingUserInputRequest({ id: 'x' })).toBeNull();
    expect(
      helpers.toPendingUserInputRequest({
        id: 'req', threadId: 'thread', turnId: 'turn', itemId: 'item', requestedAt: 'now', questions: [null, {}],
      })
    ).toBeNull();

    const request = helpers.toPendingUserInputRequest({
      id: 'req',
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'item',
      requestedAt: 'now',
      questions: [
        {
          id: 'q1',
          header: 'Pick',
          question: 'Which one?\n1. Inline A\n2. Inline B',
          isOther: true,
          isSecret: false,
          options: [
            null,
            { title: 'Title', detail: 'Detail' },
            { value: 'Value' },
            { text: 'Text', description: 'Description' },
            { nope: true },
          ],
        },
        {
          id: 'q2',
          header: 'Inline',
          question: 'Choose one:\nA) Alpha - Fast\nB) Beta - Safe',
          options: [],
        },
      ],
    });
    expect(request?.questions[0]).toMatchObject({
      question: 'Which one?',
      options: [
        { label: 'Title', description: 'Detail' },
        { label: 'Value', description: '' },
        { label: 'Text', description: 'Description' },
      ],
      isOther: true,
      isSecret: false,
    });
    expect(request?.questions[1].options).toHaveLength(2);
    expect(helpers.buildUserInputDrafts(request!)).toEqual({ q1: '', q2: '' });
  });

  it('parses every bridge UI block and rejects malformed surfaces', () => {
    expect(helpers.toBridgeUiSurface(null)).toBeNull();
    expect(helpers.toBridgeUiSurface({ id: 'x' })).toBeNull();
    expect(helpers.toBridgeUiSurface({ id: 'x', threadId: 't', title: 'T', presentation: 'other' })).toBeNull();
    const surface = helpers.toBridgeUiSurface({
      id: 'surface',
      threadId: 'thread',
      presentation: 'modal',
      title: 'Title',
      tone: 'bad',
      dismissible: false,
      blocks: [
        null,
        { type: 'text', text: 'Text' },
        { type: 'text', text: '' },
        { type: 'markdown', markdown: '**Markdown**' },
        { type: 'markdown', markdown: 2 },
        { type: 'checklist', items: [null, {}, { label: 'One', status: 'completed', detail: 'done' }, { label: 'Two', status: 'bad' }] },
        { type: 'checklist', items: [] },
        { type: 'keyValue', items: [null, { label: 'L', value: 'V' }, { label: '', value: 'V' }] },
        { type: 'keyValue', items: 'bad' },
        { type: 'code', text: 'const x = 1', language: 'ts' },
        { type: 'code', text: '' },
        { type: 'progress', label: 'Progress', value: 1, max: 2, detail: 'half' },
        { type: 'progress', label: 'Bad', value: 1, max: 0 },
        { type: 'unknown' },
      ],
      actions: [null, {}, { id: 'ok', label: 'OK', style: 'primary', dismissesSurface: false }, { id: 'odd', label: 'Odd', style: 'odd' }],
    });
    expect(surface).toMatchObject({
      tone: undefined,
      dismissible: false,
      blocks: [
        { type: 'text' },
        { type: 'markdown' },
        { type: 'checklist' },
        { type: 'keyValue' },
        { type: 'code' },
        { type: 'progress' },
      ],
      actions: [
        { id: 'ok', style: 'primary', dismissesSurface: false },
        { id: 'odd', style: undefined, dismissesSurface: true },
      ],
    });
    expect(helpers.toBridgeUiSurface({ id: 'x', threadId: 't', title: 'T', presentation: 'banner', blocks: 'bad' })?.blocks).toEqual([]);
    expect(helpers.buildOptimisticGoalBridgeUiSurface('', 'goal', 'now')).toBeNull();
    expect(helpers.buildOptimisticGoalBridgeUiSurface('thread', ' ', 'now')).toBeNull();
  });

  it('updates and removes bridge UI surfaces without mutating inputs', () => {
    const first = helpers.buildOptimisticGoalBridgeUiSurface('one', 'First', 'now')!;
    const replacement = { ...first, title: 'Replacement' };
    expect(helpers.upsertBridgeUiSurfaceList([], first)).toEqual([first]);
    const original = [first];
    expect(helpers.upsertBridgeUiSurfaceList(original, replacement)).toEqual([replacement]);
    expect(original[0].title).toBe('Goal');
    expect(helpers.removeBridgeUiSurfaceFromList([first], first.id)).toEqual([]);
  });

  it('normalizes answers and parses inline choices with continuations', () => {
    expect(helpers.normalizeQuestionAnswers(' one, two\n\nthree ')).toEqual(['one', 'two', 'three']);
    expect(helpers.stripOptionText(' **A   value** ')).toBe('A value');
    expect(helpers.splitOptionLine('')).toEqual({ label: '', description: '' });
    expect(helpers.splitOptionLine('• **Fast** — quick')).toEqual({ label: 'Fast', description: 'quick' });
    expect(helpers.splitOptionLine('Name: detail')).toEqual({ label: 'Name', description: 'detail' });
    expect(helpers.splitOptionLine('No separator')).toEqual({ label: 'No separator', description: '' });
    expect(helpers.isLikelyOptionContinuationLine('')).toBe(false);
    expect(helpers.isLikelyOptionContinuationLine('- more')).toBe(true);
    expect(helpers.isLikelyOptionContinuationLine('Trade-off: slower')).toBe(true);
    expect(helpers.isLikelyOptionContinuationLine('ordinary')).toBe(false);
    expect(helpers.parseInlineOptionsFromQuestionText('')).toEqual({ question: '', options: null });
    expect(helpers.parseInlineOptionsFromQuestionText('Question\n1. Only one')).toEqual({ question: 'Question\n1. Only one', options: null });
    expect(helpers.parseInlineOptionsFromQuestionText('1. Alpha\n- benefit: fast\n2. Beta')).toEqual({
      question: 'Select one option.',
      options: [
        { label: 'Alpha', description: 'benefit: fast' },
        { label: 'Beta', description: '' },
      ],
    });
  });

  it('finds only plausible recent inline choice sets', () => {
    expect(helpers.findInlineChoiceSet([])).toBeNull();
    expect(helpers.findInlineChoiceSet([message('u', 'user', 'Choose:\n1. A\n2. B')])).toBeNull();
    expect(helpers.findInlineChoiceSet([message('a', 'assistant', 'x'.repeat(1201))])).toBeNull();
    expect(helpers.findInlineChoiceSet([message('a', 'assistant', 'List\n1. A\n2. B')])).toBeNull();
    expect(helpers.findInlineChoiceSet([message('a', 'assistant', 'Which one?\n1. A\n2. B')])).toEqual({
      messageId: 'a',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    });
    expect(helpers.findInlineChoiceSet([message('a', 'assistant', 'Choose one\n1. A\n2. B\n3. C\n4. D\n5. E\n6. F')])).toBeNull();
  });

  it('normalizes workspace, clone, and mention paths', () => {
    expect(helpers.normalizeWorkspacePath(undefined)).toBeNull();
    expect(helpers.normalizeWorkspacePath('  ')).toBeNull();
    expect(helpers.normalizeWorkspacePath(' /repo ')).toBe('/repo');
    expect(helpers.getWorkspaceBrowseCacheKey(null)).toBe('__bridge_default__');
    expect(helpers.getWorkspaceBrowseCacheKey('/repo')).toBe('/repo');
    expect(helpers.normalizeAttachmentPath(null)).toBeNull();
    expect(helpers.normalizeAttachmentPath(' file ')).toBe('file');
    expect(helpers.normalizeCloneDirectoryName(undefined)).toBeNull();
    expect(helpers.normalizeCloneDirectoryName('.')).toBeNull();
    expect(helpers.normalizeCloneDirectoryName('..')).toBeNull();
    expect(helpers.normalizeCloneDirectoryName('a/b')).toBeNull();
    expect(helpers.normalizeCloneDirectoryName(' repo ')).toBe('repo');
    expect(helpers.deriveCloneDirectoryName(undefined)).toBeNull();
    expect(helpers.deriveCloneDirectoryName(' ')).toBeNull();
    expect(helpers.deriveCloneDirectoryName('git@github.com:owner/repo.git/')).toBe('repo');
    expect(helpers.deriveCloneDirectoryName('repo.git')).toBe('repo');
    expect(helpers.joinWorkspacePath('/repo/', 'file')).toBe('/repo/file');
    expect(helpers.joinWorkspacePath('C:\\repo', 'file')).toBe('C:\\repo\\file');
    expect(helpers.joinWorkspacePath('/repo', 'file')).toBe('/repo/file');
    expect(helpers.isAbsoluteWorkspacePath('/repo')).toBe(true);
    expect(helpers.isAbsoluteWorkspacePath('C:\\repo')).toBe(true);
    expect(helpers.isAbsoluteWorkspacePath('relative')).toBe(false);
    expect(helpers.resolveMentionPath(' ', '/repo')).toBe(' ');
    expect(helpers.resolveMentionPath('/file', '/repo')).toBe('/file');
    expect(helpers.resolveMentionPath('file', null)).toBe('file');
    expect(helpers.resolveMentionPath('file', '/repo')).toBe('/repo/file');
    expect(helpers.toMentionInput('dir/file.ts')).toEqual({ path: 'dir/file.ts', name: 'file.ts' });
  });

  it('builds and reconciles optimistic transcript content', () => {
    expect(helpers.toOptimisticUserContent('hello', [], [])).toBe('hello');
    expect(helpers.toOptimisticUserContent('hello', [{ path: '/a', name: 'a' }], [{ path: '/i' }])).toBe('hello\n[file: /a]\n[local image: /i]');
    const messages = [message('u1', 'user', 'one'), message('a', 'assistant', 'ok'), message('u2', 'user', 'two')];
    expect(helpers.countUserMessages(messages)).toBe(2);
    expect(helpers.isSyntheticUserAttachmentLine('[file: /a]')).toBe(true);
    expect(helpers.isSyntheticUserAttachmentLine('[local image: /i]')).toBe(true);
    expect(helpers.isSyntheticUserAttachmentLine('[image: /i]')).toBe(true);
    expect(helpers.isSyntheticUserAttachmentLine('text')).toBe(false);
    expect(helpers.normalizeChatMessageMatchContent(' hello \r\n[file: /a]\n world ')).toBe('hello\nworld');

    const base = chat({ messages: [message('server', 'user', 'hello\n[file: /a]')], lastMessagePreview: 'server' });
    const matching = [{ message: message('pending', 'user', 'hello'), userOrdinal: 1 }];
    expect(helpers.reconcileChatWithPendingOptimisticMessages(base, [])).toEqual({ chat: base, remainingPendingMessages: [] });
    expect(helpers.reconcileChatWithPendingOptimisticMessages(base, matching)).toEqual({ chat: base, remainingPendingMessages: [] });
    const pending = [{ message: message('pending', 'user', 'new\n[image: /i]'), userOrdinal: 2 }];
    const reconciled = helpers.reconcileChatWithPendingOptimisticMessages(base, pending);
    expect(reconciled.chat.messages).toHaveLength(2);
    expect(reconciled.chat.lastMessagePreview).toBe('new');
    expect(helpers.reconcileChatWithPendingOptimisticMessages({ ...base, lastMessagePreview: 'fallback' }, [{ message: message('empty', 'user', '[file: /a]'), userOrdinal: 2 }]).chat.lastMessagePreview).toBe('fallback');
  });

  it('ranks attachment suggestions and edits active mentions', () => {
    expect(helpers.toPathBasename('')).toBe('image');
    expect(helpers.toPathBasename('a\\b.ts')).toBe('b.ts');
    expect(helpers.toAttachmentPathSuggestions([], 'a', [])).toEqual([]);
    expect(helpers.toAttachmentPathSuggestions(['', 'a.ts', 'src/apple.ts', 'apple/path.ts', 'src/mapple.ts', 'lib/apple/file.ts'], 'apple', ['a.ts'])).toEqual([
      'src/apple.ts', 'apple/path.ts', 'src/mapple.ts', 'lib/apple/file.ts',
    ]);
    expect(helpers.toAttachmentPathSuggestions(Array.from({ length: 10 }, (_, index) => `f${index}`), '', [])).toHaveLength(8);
    expect(helpers.parseMentionQuery('hello')).toBeNull();
    expect(helpers.parseMentionQuery('hello (@src')).toBe('src');
    expect(helpers.parseMentionQuery('@')).toBe('');
    expect(helpers.replaceActiveMentionQueryWithSelection('hello @src', ' ')).toBe('hello @src');
    expect(helpers.replaceActiveMentionQueryWithSelection('hello  @src', 'file.ts')).toBe('hello @file.ts ');
    expect(helpers.escapeRegex('a+b')).toBe('a\\+b');
    expect(helpers.draftContainsMentionLabel('hello', '')).toBe(false);
    expect(helpers.draftContainsMentionLabel('use @a+b now', 'a+b')).toBe(true);
    expect(helpers.draftContainsMentionLabel('use @ab now', 'a+b')).toBe(false);
  });

  it('normalizes models, reasoning, service tier, and selection', () => {
    expect(helpers.normalizeModelId(undefined)).toBeNull();
    expect(helpers.normalizeModelId(' ')).toBeNull();
    expect(helpers.normalizeModelId(' model ')).toBe('model');
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(helpers.normalizeReasoningEffort(` ${effort.toUpperCase()} `)).toBe(effort);
    }
    expect(helpers.normalizeReasoningEffort(undefined)).toBeNull();
    expect(helpers.normalizeReasoningEffort('other')).toBeNull();
    expect(helpers.normalizeServiceTier(undefined)).toBeNull();
    expect(helpers.normalizeServiceTier(' FLEX ')).toBe('flex');
    expect(helpers.normalizeServiceTier('fast')).toBe('fast');
    expect(helpers.normalizeServiceTier('standard')).toBeNull();
    expect(helpers.toSelectedServiceTier('fast')).toBe('fast');
    expect(helpers.toSelectedServiceTier('flex')).toBeNull();
    expect(helpers.resolveSelectedServiceTier(undefined, 'fast')).toBe('fast');
    expect(helpers.resolveSelectedServiceTier(null, 'fast')).toBeNull();
  });

  it('parses workspace favorites and draft persistence safely', () => {
    expect(helpers.parseWorkspaceFavoritePaths('')).toEqual([]);
    expect(helpers.parseWorkspaceFavoritePaths('{')).toEqual([]);
    expect(helpers.parseWorkspaceFavoritePaths('{}')).toEqual([]);
    expect(helpers.parseWorkspaceFavoritePaths(JSON.stringify({ version: 1, paths: 'bad' }))).toEqual([]);
    expect(helpers.parseWorkspaceFavoritePaths(JSON.stringify({ version: 1, paths: [' ', '/a', '/a', '/b', '/c', '/d', '/e'] }))).toEqual(['/a', '/b', '/c', '/d']);

    expect(helpers.parseChatDrafts('')).toEqual({});
    expect(helpers.parseChatDrafts('{')).toEqual({});
    expect(helpers.parseChatDrafts('{}')).toEqual({});
    expect(helpers.parseChatDrafts(JSON.stringify({ version: 2, entries: null }))).toEqual({});
    expect(helpers.parseChatDrafts(JSON.stringify({ version: 2, entries: { ' ': 'x', good: 'a\r\nb', empty: '', bad: 3 } }))).toEqual({ good: 'a\nb' });
  });

  it('parses bridge queue state and errors', () => {
    expect(helpers.parseBridgeThreadQueueState(null)).toBeNull();
    expect(helpers.parseBridgeThreadQueueState({ threadId: ' ' })).toBeNull();
    expect(helpers.parseBridgeThreadQueueState({ threadId: 'thread', items: 'bad' })).toEqual({
      threadId: 'thread', items: [], pendingSteers: [], pendingSteerCount: 0,
      waitingForToolCalls: false, steeringInFlight: false, lastError: null,
    });
    expect(helpers.parseBridgeThreadQueueState({
      threadId: ' thread ',
      items: [null, {}, { id: ' i ', createdAt: ' now ', content: 'a\r\nb' }],
      pendingSteers: [{ id: ' s ', createdAt: ' later ', content: 'steer' }],
      pendingSteerCount: 1,
      waitingForToolCalls: true,
      lastError: { message: ' failed ', operation: ' send ', at: ' then ', itemId: ' item ' },
    })).toEqual({
      threadId: 'thread',
      items: [{ id: 'i', createdAt: 'now', content: 'a\nb' }],
      pendingSteers: [{ id: 's', createdAt: 'later', content: 'steer' }],
      pendingSteerCount: 1,
      waitingForToolCalls: true,
      steeringInFlight: false,
      lastError: { message: 'failed', operation: 'send', at: 'then', itemId: 'item' },
    });
    expect(helpers.getDraftScopeKey(' thread ')).toBe('thread');
    expect(helpers.getDraftScopeKey(' ')).toBe(helpers.CHAT_NEW_DRAFT_KEY);
    expect(helpers.getDraftScopeKey(undefined)).toBe(helpers.CHAT_NEW_DRAFT_KEY);
  });

  it('gates queue steering only on bridge capability and queue ownership state', () => {
    const base = {
      hasQueuedMessage: true,
      hasSelectedThread: true,
      supportsSteer: true,
      isPendingSteer: false,
      isOptimistic: false,
      actionInFlight: false,
    };
    expect(helpers.canOfferQueuedMessageSteer(base)).toBe(true);
    expect(helpers.canOfferQueuedMessageSteer({ ...base, supportsSteer: false })).toBe(false);
    expect(helpers.canOfferQueuedMessageSteer({ ...base, isPendingSteer: true })).toBe(false);
    expect(helpers.canOfferQueuedMessageSteer({ ...base, isOptimistic: true })).toBe(false);
    expect(helpers.canOfferQueuedMessageSteer({ ...base, actionInFlight: true })).toBe(false);
  });

  it('uses exact pending-tool and in-flight steering labels', () => {
    const base = {
      pendingSubmission: false,
      steeringActive: false,
      steeringInFlight: false,
      steerPending: true,
      waitingForToolCalls: false,
    };
    expect(helpers.queuedMessageStatusLabel(base)).toBe('Waiting to steer');
    expect(helpers.queuedMessageStatusLabel({ ...base, waitingForToolCalls: true })).toBe(
      'Will steer after the current tool finishes'
    );
    expect(helpers.queuedMessageStatusLabel({ ...base, steeringInFlight: true })).toBe(
      'Steering turn'
    );
  });

  it('hydrates model preferences and plan snapshots', () => {
    expect(helpers.parseChatModelPreferences('')).toEqual({});
    expect(helpers.parseChatModelPreferences('{')).toEqual({});
    expect(helpers.parseChatModelPreferences('{}')).toEqual({});
    expect(helpers.parseChatModelPreferences(JSON.stringify({ version: 1, entries: null }))).toEqual({});
    const preferences = helpers.parseChatModelPreferences(JSON.stringify({
      version: 1,
      entries: { ' ': {}, invalid: null, thread: { modelId: ' model ', effort: 'HIGH', serviceTier: 'fast' } },
    }));
    expect(preferences.thread).toMatchObject({ modelId: 'model', effort: 'high', serviceTier: 'fast' });
    expect(preferences.thread.updatedAt).toBe(new Date(0).toISOString());

    expect(helpers.parseChatPlanSnapshots('')).toEqual({});
    expect(helpers.parseChatPlanSnapshots('{')).toEqual({});
    expect(helpers.parseChatPlanSnapshots('{}')).toEqual({});
    expect(helpers.parseChatPlanSnapshots(JSON.stringify({ version: 1, entries: null }))).toEqual({});
    const snapshots = helpers.parseChatPlanSnapshots(JSON.stringify({
      version: 1,
      entries: {
        invalid: null,
        ' ': { turnId: 't' },
        missing: {},
        thread: { turnId: 'turn', steps: [null, {}, { step: 'bad', status: 'bad' }, { step: 'ok', status: 'inProgress' }] },
      },
    }));
    expect(snapshots.thread).toMatchObject({ threadId: 'thread', turnId: 'turn', explanation: null, steps: [{ step: 'ok', status: 'inProgress' }], deltaText: '' });
  });

  it('rejects invalid persisted bridge UI containers', () => {
    expect(helpers.parseChatBridgeUiSurfaces('')).toEqual({});
    expect(helpers.parseChatBridgeUiSurfaces('{')).toEqual({});
    expect(helpers.parseChatBridgeUiSurfaces('{}')).toEqual({});
    expect(helpers.parseChatBridgeUiSurfaces(JSON.stringify({ version: 1, entries: null }))).toEqual({});
    expect(helpers.parseChatBridgeUiSurfaces(JSON.stringify({ version: 1, entries: { ' ': [], thread: 'bad', empty: [null] } }))).toEqual({});
  });

  it('formats collaboration and bridge recovery states', () => {
    expect(helpers.formatCollaborationModeLabel('plan')).toBe('Plan mode');
    expect(helpers.formatCollaborationModeLabel('default')).toBe('Default mode');
    expect(helpers.isBridgeConnectionErrorMessage(null)).toBe(false);
    expect(helpers.isBridgeConnectionErrorMessage('Bridge WebSocket closed')).toBe(true);
    expect(helpers.isBridgeConnectionErrorMessage('other')).toBe(false);
    expect(helpers.isBridgeRecoveryActivity(null)).toBe(false);
    expect(helpers.isBridgeRecoveryActivity({ tone: 'idle', title: 'Disconnected' })).toBe(true);
    expect(helpers.isBridgeRecoveryActivity({ tone: 'idle', title: 'Other', detail: 'Unable to connect to bridge websocket' })).toBe(true);
    expect(helpers.isBridgeRecoveryActivity({ tone: 'idle', title: 'Other' })).toBe(false);
  });

  it('resolves visible message windows and collaboration snapshots', () => {
    expect(helpers.getInitialVisibleMessageStartIndex(120)).toBe(0);
    expect(helpers.getInitialVisibleMessageStartIndex(150)).toBe(70);
    expect(helpers.resolveSnapshotCollaborationMode(null)).toBe('default');
    expect(helpers.resolveSnapshotCollaborationMode({ updatedAtMs: 1, pendingUserInputRequest: {} as PendingUserInputRequest })).toBe('plan');
    expect(helpers.resolveSnapshotCollaborationMode({ updatedAtMs: 1, plan, activeTurnId: 'turn' })).toBe('plan');
    expect(helpers.resolveSnapshotCollaborationMode({ updatedAtMs: 1, plan, activity: { tone: 'running', title: 'Planning' } })).toBe('plan');
    expect(helpers.resolveSnapshotCollaborationMode({ updatedAtMs: 1, plan })).toBe('default');
  });

  it('selects and merges displayed plans', () => {
    expect(helpers.resolveDisplayedThreadPlan(plan, null, null)).toBe(plan);
    expect(helpers.resolveDisplayedThreadPlan(null, plan, null)).toBe(plan);
    const sparse = { ...plan, explanation: null, steps: [], updatedAt: '2026-07-18T11:00:00.000Z' };
    expect(helpers.resolveDisplayedThreadPlan(sparse, plan, null)).toEqual({ ...sparse, explanation: 'Explain', steps: plan.steps, updatedAt: plan.updatedAt });
    const other = { ...plan, turnId: 'turn-2' };
    expect(helpers.resolveDisplayedThreadPlan(other, plan, { updatedAtMs: 1 })).toBe(plan);
    expect(helpers.resolveDisplayedThreadPlan(other, plan, { updatedAtMs: 1, activeTurnId: 'turn-2' })).toBe(other);
    expect(helpers.resolveDisplayedThreadPlan(other, plan, { updatedAtMs: 1, activity: { tone: 'running', title: 'Planning' } })).toBe(other);
    expect(helpers.toPersistedActivePlanState(null, null)).toBeNull();
    expect(helpers.toPersistedActivePlanState(plan, null)).toMatchObject({ deltaText: '', updatedAt: new Date(0).toISOString() });
  });

  it('resolves plan implementation prompts and statuses', () => {
    const prompt = { threadId: 'thread', turnId: 'turn' };
    expect(helpers.resolveUndismissedPlanImplementationPrompt(null, null)).toBeNull();
    expect(helpers.resolveUndismissedPlanImplementationPrompt(prompt, 'turn')).toBeNull();
    expect(helpers.resolveUndismissedPlanImplementationPrompt(prompt, 'other')).toBe(prompt);
    expect(helpers.resolvePersistedPlanImplementationPrompt(null, null)).toBeNull();
    const withPlan = chat({ latestTurnPlan: plan, latestTurnStatus: 'Completed' });
    expect(helpers.resolvePersistedPlanImplementationPrompt(withPlan, 'turn-1')).toBeNull();
    expect(helpers.resolvePersistedPlanImplementationPrompt(withPlan, null)).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    expect(helpers.resolvePersistedPlanImplementationPrompt({ ...withPlan, latestTurnStatus: 'running' }, null)).toBeNull();
    expect(helpers.normalizePlanTurnStatus(null)).toBeNull();
    expect(helpers.normalizePlanTurnStatus(' -- ')).toBeNull();
    expect(helpers.normalizePlanTurnStatus(' In Progress ')).toBe('inprogress');
    for (const status of ['completed', 'complete', 'success', 'succeeded']) {
      expect(helpers.isCompletedPlanTurnStatus(status)).toBe(true);
    }
    expect(helpers.isCompletedPlanTurnStatus('failed')).toBe(false);
  });

  it('formats effort and detects plan-mode assistant failures', () => {
    expect(helpers.formatReasoningEffort('xhigh')).toBe('X-High');
    expect(helpers.formatReasoningEffort('none')).toBe('None');
    expect(helpers.formatReasoningEffort('minimal')).toBe('Minimal');
    expect(helpers.formatReasoningEffort('high')).toBe('High');
    expect(helpers.shouldAutoEnablePlanModeFromChat(chat({ latestTurnPlan: plan }))).toBe(true);
    expect(helpers.shouldAutoEnablePlanModeFromChat(chat({ messages: [message('u', 'user', 'x')] }))).toBe(false);
    expect(helpers.shouldAutoEnablePlanModeFromChat(chat({ messages: [message('a', 'assistant', 'request_user_input is unavailable in default mode')] }))).toBe(true);
    expect(helpers.shouldAutoEnablePlanModeFromChat(chat({ messages: [message('a', 'assistant', 'request_user_input cannot run in default mode; switch to plan mode because it is unavailable')] }))).toBe(true);
    expect(helpers.shouldAutoEnablePlanModeFromChat(chat({ messages: [message('a', 'assistant', 'normal')] }))).toBe(false);
  });

  it('parses, filters, deduplicates, and checks slash commands', () => {
    expect(helpers.parseSlashCommand('hello')).toBeNull();
    expect(helpers.parseSlashCommand('/')).toEqual({ name: 'help', args: '' });
    expect(helpers.parseSlashCommand('/$')).toBeNull();
    expect(helpers.parseSlashCommand(' /MODEL  gpt ')).toEqual({ name: 'model', args: 'gpt' });
    expect(helpers.parseSlashQuery('hello')).toBeNull();
    expect(helpers.parseSlashQuery(' /')).toBe('');
    expect(helpers.parseSlashQuery('/MODEL value')).toBe('model');
    expect(helpers.findSlashCommandDefinition('')).toBeNull();
    expect(helpers.findSlashCommandDefinition('exit')?.name).toBe('exit');
    expect(helpers.findSlashCommandDefinition('missing')).toBeNull();
    const commands: helpers.SlashCommandDefinition[] = [
      { name: 'One', summary: 'First summary', aliases: ['uno'], mobileSupported: true },
      { name: 'one', summary: 'duplicate', mobileSupported: true },
      { name: ' ', summary: 'empty', mobileSupported: true },
      { name: 'Two', summary: 'Second', mobileSupported: true },
    ];
    expect(helpers.dedupeSlashCommandsByName(commands).map((item) => item.name)).toEqual(['One', 'Two']);
    expect(helpers.filterSlashCommands('', commands)).toHaveLength(2);
    expect(helpers.filterSlashCommands('first', commands).map((item) => item.name)).toEqual(['One']);
    expect(helpers.filterSlashCommands('uno', commands).map((item) => item.name)).toEqual(['One']);
    expect(helpers.filterSlashCommands('two', commands).map((item) => item.name)).toEqual(['Two']);
    const all = { hasOpenChat: true, supportsGoal: true, supportsPlanMode: true, supportsReview: true };
    expect(helpers.isSlashCommandAvailable({ name: 'x', summary: '', mobileSupported: false }, all)).toBe(false);
    expect(helpers.isSlashCommandAvailable({ name: 'x', summary: '', mobileSupported: true, requiresOpenChat: true }, { ...all, hasOpenChat: false })).toBe(false);
    for (const name of ['goal', 'plan', 'review']) {
      const key = `supports${name === 'goal' ? 'Goal' : name === 'plan' ? 'PlanMode' : 'Review'}` as keyof typeof all;
      expect(helpers.isSlashCommandAvailable({ name, summary: '', mobileSupported: true }, { ...all, [key]: false })).toBe(false);
    }
    expect(helpers.isSlashCommandAvailable({ name: 'status', summary: '', mobileSupported: true }, all)).toBe(true);
  });

  it('formats agent thread options and icons', () => {
    expect(helpers.formatAgentThreadOptionTitle(summary({ title: ' Root ' }), 'thread-1', null)).toBe('Root');
    expect(helpers.formatAgentThreadOptionTitle(summary({ title: ' ' }), 'thread-1', null)).toBe('Main thread');
    expect(helpers.formatAgentThreadOptionTitle(summary({ id: 'child', agentNickname: ' Atlas ' }), 'thread-1', 1)).toBe('Atlas');
    expect(helpers.formatAgentThreadOptionTitle(summary({ id: 'child' }), 'thread-1', 2)).toBe('Sub-agent 2');
    expect(helpers.formatAgentThreadOptionTitle(summary({ id: 'child' }), null, null)).toBe('Sub-agent');
    expect(helpers.iconForAgentThread(summary(), 'thread-1')).toBe('chatbubble-ellipses-outline');
    expect(helpers.iconForAgentThread(summary({ id: 'review', sourceKind: 'subAgentReview' }), 'thread-1')).toBe('shield-checkmark-outline');
    expect(helpers.iconForAgentThread(summary({ id: 'compact', sourceKind: 'subAgentCompact' }), 'thread-1')).toBe('layers-outline');
    expect(helpers.iconForAgentThread(summary({ id: 'child', status: 'running' }), 'thread-1')).toBe('sparkles-outline');
    expect(helpers.iconForAgentThread(summary({ id: 'child' }), 'thread-1')).toBe('git-branch-outline');
  });

  it('formats snippets, streaming deltas, and reasoning messages', () => {
    expect(helpers.stripMarkdownInline('# **Bold** `code` _x_')).toBe('Bold code x');
    expect(helpers.toTickerSnippet(null)).toBeNull();
    expect(helpers.toTickerSnippet('   ')).toBeNull();
    expect(helpers.toTickerSnippet(' short ', 10)).toBe('short');
    expect(helpers.toTickerSnippet('long value', 5)).toBe('long…');
    expect(helpers.toTickerSnippet('long', 0)).toBe('l…');
    expect(helpers.mergeStreamingDelta('old', '')).toBe('old');
    expect(helpers.mergeStreamingDelta(null, '')).toBe('');
    expect(helpers.mergeStreamingDelta(null, 'new')).toBe('new');
    expect(helpers.mergeStreamingDelta('abc', 'abc')).toBe('abc');
    expect(helpers.mergeStreamingDelta('abc', 'bc')).toBe('abc');
    expect(helpers.mergeStreamingDelta('abc', 'abcd')).toBe('abcd');
    expect(helpers.mergeStreamingDelta('abc', 'cde')).toBe('abcde');
    expect(helpers.mergeStreamingDelta('abc', 'xyz')).toBe('abcxyz');
    expect(helpers.formatLiveReasoningMessage(' ')).toBe('• Reasoning');
    expect(helpers.formatLiveReasoningMessage('\n\n')).toBe('• Reasoning');
    expect(helpers.formatLiveReasoningMessage('First\n\nSecond')).toBe('• Reasoning\n  └ First\n    Second');
  });

  it('formats timeline messages without agent-name filtering', () => {
    expect(helpers.formatTimelineSystemMessage('Title', [])).toBe('Title');
    expect(helpers.formatTimelineSystemMessage('Title', ['one\n', '', 'two'])).toBe('Title\n  └ one\n    two');
    const messages = [message('r', 'system', 'reason'), message('a', 'assistant', 'answer')];
    messages[0].systemKind = 'reasoning';
    expect(helpers.filterReasoningMessages(messages)).toBe(messages);
  });

  it('describes started and completed tool events', () => {
    expect(helpers.describeStartedToolEvent(null)).toBeNull();
    expect(helpers.describeStartedToolEvent({ type: 'commandExecution' })).toEqual({ eventType: 'command.running', detail: 'Command | running' });
    expect(helpers.describeStartedToolEvent({ type: 'fileChange' })?.eventType).toBe('file_change.running');
    expect(helpers.describeStartedToolEvent({ type: 'mcpToolCall', server: 's', tool: 't' })?.detail).toBe('s / t | running');
    expect(helpers.describeStartedToolEvent({ type: 'mcpToolCall' })?.detail).toBe('Tool call | running');
    expect(helpers.describeStartedToolEvent({ type: 'toolCall', name: 'n' })?.detail).toBe('n | running');
    expect(helpers.describeCompletedToolEvent(null)).toBeNull();
    expect(helpers.describeCompletedToolEvent({ type: 'commandExecution', command: 'npm test', status: 'failed' })?.detail).toBe('npm test | error');
    expect(helpers.describeCompletedToolEvent({ type: 'fileChange', changes: [] })?.detail).toBe('File changes | complete');
    expect(helpers.describeCompletedToolEvent({ type: 'fileChange', changes: ['/a.ts'] })?.detail).toBe('File changes: a.ts | complete');
    expect(helpers.describeCompletedToolEvent({ type: 'fileChange', changes: ['/a.ts', '/b.ts'] })?.detail).toBe('File changes: a.ts +1 | complete');
    expect(helpers.describeCompletedToolEvent({ type: 'mcpToolCall' })?.eventType).toBe('tool.completed');
    expect(helpers.describeCompletedToolEvent({ type: 'toolCall', tool: 't', status: 'error' })?.detail).toBe('t | error');
    expect(helpers.describeWebSearchToolEvent(null)?.detail).toBe('Web search | running');
    expect(helpers.describeWebSearchToolEvent({ query: 'cats' })?.detail).toBe('Web search: cats | running');
  });

  it('reads changed paths and appends bounded run history', () => {
    expect(helpers.readCompletedFileChangePaths(null)).toEqual([]);
    expect(helpers.readCompletedFileChangePaths({ changes: [null, '', 'a\\b.ts', { path: 'a/b.ts' }, { filePath: '/c' }, { file_path: '/d' }, {}] })).toEqual(['a/b.ts', '/c', '/d']);
    expect(helpers.toFileChangeTargetLabel(' ')).toBe('file');
    expect(helpers.toFileChangeTargetLabel('/a/b.ts')).toBe('b.ts');
    const existing = [{ id: '1', threadId: 't', eventType: 'x', at: 'now', detail: 'same' }];
    expect(helpers.appendRunEventHistory(existing, 't', 'x', 'same')).toBe(existing);
    const many = Array.from({ length: helpers.MAX_ACTIVE_COMMANDS }, (_, index) => ({ id: String(index), threadId: 't', eventType: 'x', at: 'now', detail: String(index) }));
    expect(helpers.appendRunEventHistory(many, 't', 'y', 'new')).toHaveLength(helpers.MAX_ACTIVE_COMMANDS);
  });

  it('extracts thread and parent ids from common notification shapes', () => {
    expect(helpers.extractNotificationThreadId(null)).toBeNull();
    expect(helpers.extractNotificationThreadId(null, null)).toBeNull();
    expect(helpers.extractNotificationThreadId({ msg: { thread_id: 'msg' } })).toBe('msg');
    expect(helpers.extractNotificationThreadId({ threadId: 'direct' })).toBe('direct');
    expect(helpers.extractNotificationThreadId({ thread: { id: 'nested' } })).toBe('nested');
    expect(helpers.extractNotificationThreadId({ turn: { threadId: 'turn' } })).toBe('turn');
    expect(helpers.extractNotificationThreadId({ source: { conversation_id: 'source' } })).toBe('source');
    expect(helpers.extractNotificationThreadId({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } })).toBe('parent');
    expect(helpers.extractNotificationThreadId({ thread: { source: { subAgent: { thread_spawn: { parentThreadId: 'thread-parent' } } } } })).toBe('thread-parent');
    expect(helpers.extractNotificationParentThreadId(null)).toBeNull();
    expect(helpers.extractNotificationParentThreadId({ source: { parentThreadId: 'parent' } })).toBe('parent');
    expect(helpers.extractNotificationParentThreadId({ thread: { source: { parent_thread_id: 'nested-parent' } } })).toBe('nested-parent');
  });

  it('extracts direct, typed, and nested external statuses', () => {
    expect(helpers.normalizeExternalStatusHint(null)).toBeNull();
    expect(helpers.normalizeExternalStatusHint(' -- ')).toBeNull();
    expect(helpers.normalizeExternalStatusHint('In Progress')).toBe('inprogress');
    expect(helpers.extractExternalStatusHint(null)).toBeNull();
    expect(helpers.extractExternalStatusHint({ status: 'Running' })).toBe('running');
    expect(helpers.extractExternalStatusHint({ status: { type: 'Complete' } })).toBe('complete');
    expect(helpers.extractExternalStatusHint({ state: { phase: 'Queued' } })).toBe('queued');
    expect(helpers.extractExternalStatusHint({ other: true })).toBeNull();
    expect(helpers.extractExternalStatusHint({ thread: { lifecycle: { status: 'Failed' } } })).toBe('failed');
  });

  it('evaluates running and unanswered chat heuristics', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(helpers.isChatSummaryLikelyRunning(summary({ status: 'running' }))).toBe(true);
    expect(helpers.isChatSummaryLikelyRunning(summary({ status: 'idle' }))).toBe(false);
    expect(helpers.isChatLikelyRunning(chat({ status: 'running' }))).toBe(true);
    for (const status of ['error', 'complete', 'idle'] as const) {
      expect(helpers.isChatLikelyRunning(chat({ status }))).toBe(false);
    }
    const unknownStatus = 'unknown' as ChatStatus;
    expect(helpers.isChatLikelyRunning(chat({ status: unknownStatus, messages: [] }))).toBe(false);
    expect(helpers.isChatLikelyRunning(chat({ status: unknownStatus, messages: [message('a', 'assistant', 'x')] }))).toBe(false);
    expect(helpers.isChatLikelyRunning(chat({ status: unknownStatus, messages: [message('u', 'user', 'x')], updatedAt: 'bad' }))).toBe(false);
    expect(helpers.isChatLikelyRunning(chat({ status: unknownStatus, messages: [message('u', 'user', 'x')], updatedAt: new Date(now - 1000).toISOString() }))).toBe(true);
    expect(helpers.hasRecentUnansweredUserTurn(chat({ messages: [] }))).toBe(false);
    expect(helpers.hasRecentUnansweredUserTurn(chat({ messages: [message('u', 'user', 'x', 'bad')] }))).toBe(false);
    expect(helpers.hasRecentUnansweredUserTurn(chat({ messages: [message('u', 'user', 'x', new Date(now - 1000).toISOString()), message('a', 'assistant', 'done')] }))).toBe(false);
    expect(helpers.hasRecentUnansweredUserTurn(chat({ messages: [message('u', 'user', 'x', new Date(now - 1000).toISOString())] }))).toBe(true);
    expect(helpers.hasRecentUnansweredUserTurn(chat({ messages: [message('u', 'user', 'x', new Date(now - 100000).toISOString())] }))).toBe(false);
    jest.restoreAllMocks();
  });

  it('detects assistant progress and latest messages', () => {
    const previous = chat({ messages: [message('u', 'user', 'x')] });
    expect(helpers.didAssistantMessageProgress(null, previous)).toBe(false);
    expect(helpers.didAssistantMessageProgress({ ...previous, id: 'other' }, previous)).toBe(false);
    expect(helpers.didAssistantMessageProgress(previous, previous)).toBe(false);
    const firstAssistant = chat({ messages: [...previous.messages, message('a', 'assistant', 'answer')] });
    expect(helpers.didAssistantMessageProgress(previous, firstAssistant)).toBe(true);
    expect(helpers.didAssistantMessageProgress(previous, chat({ messages: [...previous.messages, message('a', 'assistant', ' ')] }))).toBe(false);
    expect(helpers.didAssistantMessageProgress(firstAssistant, chat({ messages: [...previous.messages, message('a', 'assistant', 'answer more')] }))).toBe(true);
    expect(helpers.didAssistantMessageProgress(firstAssistant, chat({ messages: [...previous.messages, message('b', 'assistant', 'new')] }))).toBe(false);
    expect(helpers.didAssistantMessageProgress(firstAssistant, chat({ messages: [...firstAssistant.messages, message('b', 'assistant', 'new')] }))).toBe(true);
    expect(helpers.latestAssistantMessage(previous.messages)).toBeNull();
    expect(helpers.latestAssistantMessage(firstAssistant.messages)?.id).toBe('a');
  });

  it('extracts bold and reasoning activity snippets', () => {
    expect(helpers.extractFirstBoldSnippet(null)).toBeNull();
    expect(helpers.extractFirstBoldSnippet('plain')).toBeNull();
    expect(helpers.extractFirstBoldSnippet('**Heading** details')).toBe('Heading');
    expect(helpers.toReasoningActivityDetail(null, null)).toBeUndefined();
    expect(helpers.toReasoningActivityDetail('___', null)).toBeUndefined();
    expect(helpers.toReasoningActivityDetail('**Heading**: details', 'Heading')).toBe('details');
    expect(helpers.toReasoningActivityDetail('Heading', 'Heading')).toBeUndefined();
    expect(helpers.toReasoningActivityDetail('some detail', null, 6)).toBe('some …');
  });

  it('parses approvals and rejects incomplete or unknown kinds', () => {
    expect(helpers.toPendingApproval(null)).toBeNull();
    expect(helpers.toPendingApproval({ id: 'x' })).toBeNull();
    expect(helpers.toPendingApproval({ id: 'i', kind: 'other', threadId: 't', turnId: 'turn', itemId: 'item', requestedAt: 'now' })).toBeNull();
    expect(helpers.toPendingApproval({
      id: 'i', kind: 'commandExecution', threadId: 't', turnId: 'turn', itemId: 'item', requestedAt: 'now',
      reason: 'why', command: 'npm test', cwd: '/repo', grantRoot: '/repo', proposedExecpolicyAmendment: ['a', 2],
    })).toMatchObject({
      requestId: 'i', kind: 'commandExecution', reason: 'why', command: 'npm test', proposedExecpolicyAmendment: ['a'],
    });
    expect(helpers.toPendingApproval({ id: 'i', kind: 'fileChange', threadId: 't', turnId: 'turn', itemId: 'item', requestedAt: 'now' })?.kind).toBe('fileChange');
  });
});
