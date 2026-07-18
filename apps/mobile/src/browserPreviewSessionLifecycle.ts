export interface BrowserPreviewSessionCloser {
  closeBrowserPreviewSession(sessionId: string): Promise<boolean>;
}

export class BrowserPreviewSessionLifecycle {
  private activeSessionId: string | null = null;
  private createQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly api: BrowserPreviewSessionCloser) {}

  serializeCreate<T>(create: () => Promise<T>): Promise<T> {
    const result = this.createQueue.then(() => {
      if (this.disposed) {
        throw new Error('Preview session lifecycle is disposed');
      }
      return create();
    });
    this.createQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  adopt(sessionId: string): void {
    if (this.disposed) {
      this.close(sessionId);
      return;
    }

    const replacedSessionId = this.activeSessionId;
    this.activeSessionId = sessionId;
    if (replacedSessionId && replacedSessionId !== sessionId) {
      this.close(replacedSessionId);
    }
  }

  discard(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    this.close(sessionId);
  }

  clear(): void {
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;
    if (sessionId) {
      this.close(sessionId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private close(sessionId: string): void {
    void this.api.closeBrowserPreviewSession(sessionId).catch(() => undefined);
  }
}
