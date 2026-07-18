import { readFileSync } from 'node:fs';
import path from 'node:path';

import { HostBridgeWsClient } from '../ws';

interface ContractManifest {
  fixtureFormatVersion: number;
  protocolVersion: number;
  bridgeMethods: string[];
  mobileForwardedMethods: string[];
  notifications: string[];
  errors: Array<{ code: number; name: string }>;
  fixtures: {
    capabilities: { protocolVersion: number; streamId: string };
    notification: { method: string; protocolVersion: number; eventId: number };
    overloadError: { error: { code: number; data: { retryable: boolean } } };
    resourceLimitError: { error: { code: number; data: { resource: string; limit: number; actual: number } } };
    browserPreviewSession: { sessionId: string; bootstrapPath: string; expiresAt: string };
    truncatedGitDiff: { truncated: boolean; returnedBytes: number; maxBytes: number };
    truncatedFilesystemList: { truncated: boolean; totalEntries: number; maxEntries: number };
    submission: { submissionId: string; threadId: string; disposition: string };
  };
}

describe('bridge RPC contract fixtures', () => {
  const manifest = JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../../../../contracts/bridge-rpc/v1/manifest.json'),
      'utf8'
    )
  ) as ContractManifest;

  it('matches the mobile protocol version and canonical envelopes', () => {
    expect(manifest.fixtureFormatVersion).toBe(1);
    expect(manifest.protocolVersion).toBe(HostBridgeWsClient.PROTOCOL_VERSION);
    expect(manifest.fixtures.capabilities.protocolVersion).toBe(manifest.protocolVersion);
    expect(manifest.fixtures.notification).toMatchObject({
      protocolVersion: manifest.protocolVersion,
      eventId: 7,
    });
    expect(manifest.notifications).toContain(manifest.fixtures.notification.method);
    expect(manifest.fixtures.overloadError).toMatchObject({
      error: { code: -32005, data: { retryable: true } },
    });
    expect(manifest.fixtures.resourceLimitError).toMatchObject({
      error: { code: -32602, data: { resource: 'attachment_bytes', limit: 20971520 } },
    });
    expect(manifest.fixtures.browserPreviewSession).toMatchObject({
      sessionId: expect.any(String),
      bootstrapPath: expect.stringContaining('st='),
      expiresAt: '2026-01-01T00:30:00Z',
    });
    expect(manifest.fixtures.truncatedGitDiff.returnedBytes).toBeLessThanOrEqual(
      manifest.fixtures.truncatedGitDiff.maxBytes
    );
    expect(manifest.fixtures.truncatedFilesystemList).toMatchObject({
      truncated: true,
      totalEntries: 1001,
      maxEntries: 1000,
    });
    expect(manifest.fixtures.submission).toMatchObject({
      submissionId: expect.stringMatching(/^submission-/),
      disposition: 'queued',
    });
  });

  it('keeps inventories unique', () => {
    for (const entries of [
      manifest.bridgeMethods,
      manifest.mobileForwardedMethods,
      manifest.notifications,
    ]) {
      expect(new Set(entries).size).toBe(entries.length);
    }
    expect(new Set(manifest.errors.map((entry) => entry.code)).size).toBe(
      manifest.errors.length
    );
  });
});
