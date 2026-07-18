import { SubmissionController, submissionScopeKey } from '../submissionController';

describe('submissionController', () => {
  it('supports its default id factory', () => {
    expect(new SubmissionController().begin(
      { scopeKey: 'scope', value: '', revision: 0 },
      { mentions: [], localImages: [] }
    ).id).toMatch(/^submission-/);
  });

  it('restores only the unchanged draft in the original profile and thread scope', () => {
    const controller = new SubmissionController(() => 'submission-1');
    const scopeKey = submissionScopeKey({ profileId: 'profile-a', threadId: 'thread-1' });
    const submission = controller.begin(
      { scopeKey, value: 'hello', revision: 2 },
      { mentions: ['/repo/a.ts'], localImages: ['/repo/a.png'] }
    );
    controller.markCleared(submission, 3);

    expect(controller.fail(submission, { scopeKey, value: '', revision: 3 })).toBe(true);
    expect(
      controller.fail(submission, { scopeKey, value: 'newer edit', revision: 4 })
    ).toBe(false);
    expect(
      controller.fail(submission, {
        scopeKey: submissionScopeKey({ profileId: 'profile-b', threadId: 'thread-1' }),
        value: '',
        revision: 3,
      })
    ).toBe(false);
  });

  it('reuses a failed submission id for an exact retry including attachments', () => {
    const controller = new SubmissionController(() => 'submission-1');
    const snapshot = { scopeKey: 'scope', value: 'hello', revision: 1 };
    const attachments = { mentions: ['/a'], localImages: ['/b'] };
    const first = controller.begin(snapshot, attachments);
    controller.markCleared(first, 2);
    controller.fail(first, { ...snapshot, value: '', revision: 2 });

    expect(controller.begin(snapshot, attachments).id).toBe('submission-1');
  });

  it('normalizes scopes and generates an id when the injected id is blank', () => {
    expect(submissionScopeKey({ profileId: ' profile ', threadId: '  ' })).toBe(
      JSON.stringify(['profile', null])
    );
    const submission = new SubmissionController(() => ' ').begin(
      { scopeKey: 'scope', value: 'draft', revision: 0 },
      { mentions: [], localImages: [] }
    );
    expect(submission.id).toMatch(/^submission-.+-1$/);
  });

  it('does not restore uncleared or changed drafts and forgets successful failures', () => {
    const controller = new SubmissionController(() => 'id');
    const snapshot = { scopeKey: 'scope', value: 'draft', revision: 1 };
    const attachments = { mentions: [], localImages: [] };
    const submission = controller.begin(snapshot, attachments);
    expect(controller.fail(submission, { ...snapshot, value: '', revision: 1 })).toBe(false);
    expect(controller.begin(snapshot, attachments)).toBe(submission);
    controller.succeed(submission);
    expect(controller.begin(snapshot, attachments)).not.toBe(submission);
  });

  it('bounds retained failed submissions', () => {
    let id = 0;
    const controller = new SubmissionController(() => `id-${++id}`);
    for (let index = 0; index < 34; index += 1) {
      const submission = controller.begin(
        { scopeKey: 'scope', value: `draft-${index}`, revision: index },
        { mentions: [], localImages: [] }
      );
      controller.fail(submission, { scopeKey: 'scope', value: 'changed', revision: index });
    }
    expect(controller.begin(
      { scopeKey: 'scope', value: 'draft-0', revision: 0 },
      { mentions: [], localImages: [] }
    ).id).not.toBe('id-1');
  });
});
