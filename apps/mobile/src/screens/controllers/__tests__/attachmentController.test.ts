import {
  ATTACHMENT_MAX_BYTES,
  addUniqueAttachmentPath,
  attachmentSizeError,
  retainFailedPreparedAttachment,
} from '../attachmentController';

describe('attachmentController', () => {
  it('normalizes and deduplicates attachment paths case-insensitively', () => {
    expect(addUniqueAttachmentPath(['/repo/File.ts'], ' /repo/file.ts ')).toEqual([
      '/repo/File.ts',
    ]);
    expect(addUniqueAttachmentPath([], ' /repo/new.ts ')).toEqual(['/repo/new.ts']);
  });

  it('rejects empty paths', () => {
    expect(addUniqueAttachmentPath([], '  ')).toBeNull();
  });

  it('rejects only files above the displayed attachment limit', () => {
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES)).toBeNull();
    expect(attachmentSizeError(ATTACHMENT_MAX_BYTES + 1)).toContain('20 MB');
  });

  it('retains prepared attachment metadata after an upload failure', () => {
    const prepared = {
      id: 'file:file:///cache/report.pdf',
      uri: 'file:///cache/report.pdf',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      kind: 'file' as const,
      sizeBytes: 1024,
      status: 'uploading' as const,
    };
    expect(retainFailedPreparedAttachment([prepared], prepared.id)).toEqual([
      { ...prepared, status: 'failed' },
    ]);
  });
});
