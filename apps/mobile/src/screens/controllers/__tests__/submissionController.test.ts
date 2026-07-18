import { SubmissionController, submissionScopeKey } from '../submissionController';

describe('submissionController', () => {
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
});
