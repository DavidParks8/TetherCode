import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { syncVersions, syncVersionsForNpmLifecycle } = require('../sync-versions.js');

function createFixture(t, { cargoLockName = 'tethercode-bridge' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tethercode-version-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    'package.json': { name: 'tethercode', version: '6.0.0-beta.1' },
    'package-lock.json': {
      name: 'tethercode',
      version: '5.2.3',
      packages: {
        '': { name: 'tethercode', version: '5.2.3' },
        'apps/mobile': { name: 'tethercode', version: '5.2.3' },
        'services/rust-bridge': { name: '@tethercode/bridge', version: '5.2.3' },
      },
    },
    'apps/mobile/package.json': { name: 'tethercode', version: '5.2.3' },
    'apps/mobile/app.json': {
      expo: {
        version: '5.2.3',
        ios: { version: '5.2.3' },
        android: { version: '5.2.3' },
      },
    },
    'services/rust-bridge/package.json': { name: '@tethercode/bridge', version: '5.2.3' },
  };

  for (const [relativePath, value] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
  }
  writeFileSync(path.join(root, 'services/rust-bridge/Cargo.toml'), '[package]\nname = "tethercode-bridge"\nversion = "5.2.3"\n\n[dependencies]\n');
  writeFileSync(path.join(root, 'services/rust-bridge/Cargo.lock'), `version = 4\n\n[[package]]\nname = "${cargoLockName}"\nversion = "5.2.3"\n`);
  return root;
}

test('synchronizes package and lock metadata without generated native trees', (t) => {
  const rootDir = createFixture(t);
  const result = syncVersions({ rootDir });

  assert.equal(result.version, '6.0.0-beta.1');
  assert.equal(result.mobileVersion, '6.0.0');
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, 'apps/mobile/package.json'))).version, '6.0.0-beta.1');
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, 'apps/mobile/app.json'))).expo.ios.version, '6.0.0');
  assert.match(readFileSync(path.join(rootDir, 'services/rust-bridge/Cargo.lock'), 'utf8'), /version = "6\.0\.0-beta\.1"/);
  assert.doesNotThrow(() => syncVersions({ rootDir, check: true }));
});

test('preflights every target before writing version metadata', (t) => {
  const rootDir = createFixture(t, { cargoLockName: 'wrong-package' });
  const mobilePackagePath = path.join(rootDir, 'apps/mobile/package.json');
  const before = readFileSync(mobilePackagePath, 'utf8');

  assert.throws(
    () => syncVersions({ rootDir }),
    /Expected one tethercode-bridge package/
  );
  assert.equal(readFileSync(mobilePackagePath, 'utf8'), before);
});

test('restores npm root metadata when lifecycle synchronization fails', (t) => {
  const rootDir = createFixture(t, { cargoLockName: 'wrong-package' });

  assert.throws(
    () => syncVersionsForNpmLifecycle({ rootDir, oldVersion: '5.2.3' }),
    /Expected one tethercode-bridge package/
  );
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, 'package.json'))).version, '5.2.3');
  const packageLock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json')));
  assert.equal(packageLock.version, '5.2.3');
  assert.equal(packageLock.packages[''].version, '5.2.3');
});

test('restores every version file when lifecycle staging fails', (t) => {
  const rootDir = createFixture(t);
  const mobilePackagePath = path.join(rootDir, 'apps/mobile/package.json');

  assert.throws(
    () => syncVersionsForNpmLifecycle({
      rootDir,
      oldVersion: '5.2.3',
      stage: () => { throw new Error('index lock'); },
    }),
    /index lock/
  );
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, 'package.json'))).version, '5.2.3');
  assert.equal(JSON.parse(readFileSync(mobilePackagePath)).version, '5.2.3');
  assert.match(readFileSync(path.join(rootDir, 'services/rust-bridge/Cargo.toml'), 'utf8'), /version = "5\.2\.3"/);
});

test('rejects package build metadata before changing files', (t) => {
  const rootDir = createFixture(t);
  const rootPackagePath = path.join(rootDir, 'package.json');
  const rootPackage = JSON.parse(readFileSync(rootPackagePath));
  rootPackage.version = '6.0.0+ci.1';
  writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

  assert.throws(() => syncVersions({ rootDir }), /without build metadata/);
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, 'apps/mobile/package.json'))).version, '5.2.3');
});
