import { parseUnifiedGitDiff } from '../gitDiff';

describe('parseUnifiedGitDiff', () => {
  it('parses a modified file with numbered unified diff lines', () => {
    const input = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1234..5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      '+line3',
      ' line4',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.totalAdditions).toBe(2);
    expect(parsed.totalDeletions).toBe(1);

    const file = parsed.files[0];
    expect(file.displayPath).toBe('src/app.ts');
    expect(file.status).toBe('modified');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]).toMatchObject({
      kind: 'context',
      oldLineNumber: 1,
      newLineNumber: 1,
      content: 'line1',
    });
    expect(hunk.lines[1]).toMatchObject({
      kind: 'remove',
      oldLineNumber: 2,
      newLineNumber: null,
      content: 'line2',
    });
    expect(hunk.lines[2]).toMatchObject({
      kind: 'add',
      oldLineNumber: null,
      newLineNumber: 2,
      content: 'line2 changed',
    });
    expect(hunk.lines[4]).toMatchObject({
      kind: 'context',
      oldLineNumber: 3,
      newLineNumber: 4,
      content: 'line4',
    });
  });

  it('marks /dev/null sources as added files', () => {
    const input = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..beef123',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+const value = 1;',
      '+export default value;',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      status: 'added',
      oldPath: null,
      newPath: 'src/new.ts',
      additions: 2,
      deletions: 0,
    });
  });

  it('handles renamed files with quoted paths', () => {
    const input = [
      'diff --git "a/src/old name.ts" "b/src/new name.ts"',
      'similarity index 100%',
      'rename from src/old name.ts',
      'rename to src/new name.ts',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      status: 'renamed',
      oldPath: 'src/old name.ts',
      newPath: 'src/new name.ts',
      displayPath: 'src/old name.ts -> src/new name.ts',
      additions: 0,
      deletions: 0,
    });
  });

  it('ignores ANSI color escapes in diff output', () => {
    const input = [
      '\u001b[1mdiff --git a/src/color.ts b/src/color.ts\u001b[0m',
      '--- a/src/color.ts',
      '+++ b/src/color.ts',
      '@@ -1 +1 @@',
      '\u001b[31m-oldValue\u001b[0m',
      '\u001b[32m+newValue\u001b[0m',
    ].join('\n');

    const parsed = parseUnifiedGitDiff(input);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      displayPath: 'src/color.ts',
      additions: 1,
      deletions: 1,
    });
    expect(parsed.files[0].hunks[0].lines[0]).toMatchObject({
      kind: 'remove',
      content: 'oldValue',
    });
    expect(parsed.files[0].hunks[0].lines[1]).toMatchObject({
      kind: 'add',
      content: 'newValue',
    });
  });

  it('ignores content before the first file and malformed hunk headers', () => {
    const parsed = parseUnifiedGitDiff([
      'preamble',
      'diff --git a/a.ts b/a.ts',
      '@@ malformed @@',
      '+not counted',
    ].join('\n'));
    expect(parsed.files[0]).toMatchObject({ additions: 0, deletions: 0, hunks: [] });
  });

  it('records no-newline markers and unexpected hunk content as metadata', () => {
    const parsed = parseUnifiedGitDiff([
      'diff --git a/a.ts b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      'unexpected',
    ].join('\n'));
    expect(parsed.files[0].hunks[0].lines.slice(2)).toEqual([
      { kind: 'meta', prefix: '\\', content: 'No newline at end of file', oldLineNumber: null, newLineNumber: null },
      { kind: 'meta', prefix: ' ', content: 'unexpected', oldLineNumber: null, newLineNumber: null },
    ]);
  });

  it('marks deleted and binary files from metadata', () => {
    const parsed = parseUnifiedGitDiff([
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      'diff --git a/image.png b/image.png',
      'Binary files a/image.png and b/image.png differ',
      'diff --git a/patch.bin b/patch.bin',
      'GIT binary patch',
    ].join('\n'));
    expect(parsed.files.map((file) => file.status)).toEqual(['deleted', 'binary', 'binary']);
    expect(parsed.files[0]).toMatchObject({ oldPath: 'old.ts', newPath: null, displayPath: 'old.ts' });
  });

  it('decodes quoted escaped paths and handles incomplete diff headers', () => {
    const parsed = parseUnifiedGitDiff([
      'diff --git "a/src/a\\tname.ts" "b/src/b\\nname.ts"',
      'rename from "src/a\\tname.ts"',
      'rename to "src/b\\nname.ts"',
      'diff --git  ',
    ].join('\n'));
    expect(parsed.files[0]).toMatchObject({
      oldPath: 'src/a\tname.ts',
      newPath: 'src/b\nname.ts',
      status: 'renamed',
    });
    expect(parsed.files[1]).toMatchObject({ oldPath: null, newPath: null, displayPath: 'unknown' });
  });

  it('infers added, deleted, and renamed states from patch paths', () => {
    const parsed = parseUnifiedGitDiff([
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      'diff --git a/old-name.ts b/new-name.ts',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
    ].join('\n'));
    expect(parsed.files.map((file) => file.status)).toEqual(['added', 'deleted', 'renamed']);
    expect(parsed.files[2].displayPath).toBe('old-name.ts -> new-name.ts');
  });

  it('defaults omitted hunk counts to one and normalizes CR line endings', () => {
    const parsed = parseUnifiedGitDiff('diff --git a/a b/a\r--- a/a\r+++ b/a\r@@ -3 +4 @@\r old\r+new');
    expect(parsed.files[0].hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 4, newCount: 1 });
  });
});
