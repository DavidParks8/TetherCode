import { addUniqueAttachmentPath } from '../attachmentController';

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
});
