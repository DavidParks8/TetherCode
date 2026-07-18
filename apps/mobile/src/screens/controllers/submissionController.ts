import * as Crypto from 'expo-crypto';

export interface SubmissionScope {
  profileId: string;
  threadId: string | null;
}

export interface SubmissionDraftSnapshot {
  scopeKey: string;
  value: string;
  revision: number;
}

export interface ComposerSubmission {
  id: string;
  scopeKey: string;
  draft: string;
  mentions: string[];
  localImages: string[];
  clearedRevision: number | null;
}

const FAILED_SUBMISSION_LIMIT = 32;

export function submissionScopeKey(scope: SubmissionScope): string {
  return JSON.stringify([scope.profileId.trim(), scope.threadId?.trim() || null]);
}

export class SubmissionController {
  private readonly failed = new Map<string, ComposerSubmission>();
  private counter = 0;

  constructor(private readonly createId: () => string = () => '') {}

  begin(
    snapshot: SubmissionDraftSnapshot,
    attachments: { mentions: string[]; localImages: string[] }
  ): ComposerSubmission {
    const retryKey = this.retryKey(snapshot.scopeKey, snapshot.value, attachments);
    const retry = this.failed.get(retryKey);
    if (retry) {
      this.failed.delete(retryKey);
      retry.clearedRevision = null;
      return retry;
    }

    const generated = this.createId().trim();
    this.counter += 1;
    return {
      id:
        generated ||
        `submission-${Crypto.randomUUID()}-${this.counter.toString(36)}`,
      scopeKey: snapshot.scopeKey,
      draft: snapshot.value,
      mentions: [...attachments.mentions],
      localImages: [...attachments.localImages],
      clearedRevision: null,
    };
  }

  markCleared(submission: ComposerSubmission, revision: number): void {
    submission.clearedRevision = revision;
  }

  fail(submission: ComposerSubmission, current: SubmissionDraftSnapshot): boolean {
    const key = this.retryKey(submission.scopeKey, submission.draft, submission);
    this.failed.delete(key);
    this.failed.set(key, submission);
    while (this.failed.size > FAILED_SUBMISSION_LIMIT) {
      const oldest = this.failed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.failed.delete(oldest);
    }
    return (
      submission.clearedRevision !== null &&
      current.scopeKey === submission.scopeKey &&
      current.revision === submission.clearedRevision &&
      current.value === ''
    );
  }

  succeed(submission: ComposerSubmission): void {
    this.failed.delete(this.retryKey(submission.scopeKey, submission.draft, submission));
  }

  private retryKey(
    scopeKey: string,
    draft: string,
    attachments: { mentions: readonly string[]; localImages: readonly string[] }
  ): string {
    return JSON.stringify([scopeKey, draft, attachments.mentions, attachments.localImages]);
  }
}
