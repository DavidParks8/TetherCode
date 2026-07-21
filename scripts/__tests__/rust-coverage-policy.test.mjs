import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const checker = path.join(root, 'scripts/check-rust-coverage.mjs');

function runChecker(report, minimum = '86') {
  const directory = mkdtempSync(path.join(tmpdir(), 'tethercode-rust-coverage-'));
  const reportPath = path.join(directory, 'coverage.json');
  writeFileSync(reportPath, JSON.stringify(report));
  const result = spawnSync(process.execPath, [checker, reportPath], {
    cwd: root,
    env: { ...process.env, MIN_RUST_BRANCH_COVERAGE: minimum },
    encoding: 'utf8',
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test('Rust coverage checker accepts the exact threshold', () => {
  const result = runChecker({
    data: [{ totals: { branches: { count: 100, covered: 86 } } }],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /86\.00%/);
});

test('Rust coverage checker rejects below-threshold and empty reports', () => {
  const below = runChecker({
    data: [{ totals: { branches: { count: 100, covered: 85 } } }],
  });
  assert.equal(below.status, 1);

  const empty = runChecker({ data: [{ totals: { branches: { count: 0, covered: 0 } } }] });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /no instrumented branches/);
});
