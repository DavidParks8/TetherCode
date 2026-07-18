import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.resolve(
  root,
  process.argv[2] ?? 'services/rust-bridge/target/llvm-cov/coverage.json'
);
const minimum = Number(process.env.MIN_RUST_BRANCH_COVERAGE ?? '85');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const totals = report.data?.[0]?.totals?.branches;

if (!totals || !Number.isFinite(totals.count) || !Number.isFinite(totals.covered)) {
  throw new Error(`Rust coverage report has no branch totals: ${reportPath}`);
}
if (totals.count <= 0) {
  throw new Error('Rust coverage report contains no instrumented branches.');
}

const percentage = (totals.covered * 100) / totals.count;
process.stdout.write(
  `Rust branch coverage: ${percentage.toFixed(2)}% (${String(totals.covered)}/${String(totals.count)}), required ${minimum.toFixed(2)}%\n`
);
if (percentage + Number.EPSILON < minimum) {
  process.exitCode = 1;
}
