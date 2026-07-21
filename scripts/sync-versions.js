#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const defaultRootDir = path.resolve(__dirname, '..');
const packageVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

function readFile(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function parseJson(source, relativePath) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error instanceof Error ? error.message : error}`);
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replacePackageVersionInToml(source, version, relativePath) {
  const lines = source.split('\n');
  const packageSections = lines
    .map((line, index) => (line.trim() === '[package]' ? index : -1))
    .filter((index) => index >= 0);
  if (packageSections.length !== 1) {
    throw new Error(`Expected one [package] section in ${relativePath}`);
  }

  const sectionStart = packageSections[0] + 1;
  const sectionEnd = lines.findIndex((line, index) => index >= sectionStart && /^\s*\[/.test(line));
  const limit = sectionEnd === -1 ? lines.length : sectionEnd;
  const versionLines = [];
  for (let index = sectionStart; index < limit; index += 1) {
    if (/^\s*version\s*=/.test(lines[index])) {
      versionLines.push(index);
    }
  }
  if (versionLines.length !== 1) {
    throw new Error(`Expected one package version in ${relativePath}`);
  }

  const index = versionLines[0];
  const nextLine = lines[index].replace(/^(\s*version\s*=\s*")[^"]*(".*)$/, `$1${version}$2`);
  if (nextLine === lines[index] && !lines[index].includes(`"${version}"`)) {
    throw new Error(`Could not update the package version in ${relativePath}`);
  }
  lines[index] = nextLine;
  return lines.join('\n');
}

function replaceNamedPackageVersionInCargoLock(source, packageName, version, relativePath) {
  const lines = source.split('\n');
  const packageStarts = lines
    .map((line, index) => (line.trim() === '[[package]]' ? index : -1))
    .filter((index) => index >= 0);
  const matchingPackages = packageStarts.filter((start, packageIndex) => {
    const end = packageStarts[packageIndex + 1] ?? lines.length;
    return lines.slice(start + 1, end).some((line) => line === `name = "${packageName}"`);
  });
  if (matchingPackages.length !== 1) {
    throw new Error(`Expected one ${packageName} package in ${relativePath}`);
  }

  const start = matchingPackages[0];
  const nextStart = packageStarts.find((candidate) => candidate > start);
  const end = nextStart ?? lines.length;
  const versionLines = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^version = "[^"]*"$/.test(lines[index])) {
      versionLines.push(index);
    }
  }
  if (versionLines.length !== 1) {
    throw new Error(`Expected one ${packageName} version in ${relativePath}`);
  }
  lines[versionLines[0]] = `version = "${version}"`;
  return lines.join('\n');
}

function replacePackageVersionInCargoLock(source, version, relativePath) {
  return replaceNamedPackageVersionInCargoLock(
    source,
    'tethercode-bridge',
    version,
    relativePath
  );
}

function replaceExactly(source, pattern, replacement, relativePath, field) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(`Could not find ${field} in ${relativePath}`);
  }
  return source.replace(pattern, replacement);
}

function collectVersionUpdates(rootDir) {
  const sources = new Map();
  const updates = new Map();
  const load = (relativePath) => {
    const source = readFile(rootDir, relativePath);
    sources.set(relativePath, source);
    return source;
  };
  const updateJson = (relativePath, mutate) => {
    const value = parseJson(load(relativePath), relativePath);
    mutate(value);
    updates.set(relativePath, serializeJson(value));
  };

  const rootPackagePath = 'package.json';
  const rootPackage = parseJson(load(rootPackagePath), rootPackagePath);
  const versionMatch = typeof rootPackage.version === 'string'
    ? rootPackage.version.match(packageVersionPattern)
    : null;
  if (!versionMatch) {
    throw new Error('Root package.json version must be valid SemVer without build metadata.');
  }
  const version = rootPackage.version;
  const mobileVersion = `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`;

  updateJson('apps/mobile/package.json', (value) => {
    value.version = version;
  });
  const desktopCargoTomlPath = 'apps/desktop/Cargo.toml';
  if (fs.existsSync(path.join(rootDir, desktopCargoTomlPath))) {
    updates.set(
      desktopCargoTomlPath,
      replacePackageVersionInToml(load(desktopCargoTomlPath), version, desktopCargoTomlPath)
    );

    const desktopCargoLockPath = 'apps/desktop/Cargo.lock';
    updates.set(
      desktopCargoLockPath,
      replaceNamedPackageVersionInCargoLock(
        load(desktopCargoLockPath),
        'tethercode-desktop',
        version,
        desktopCargoLockPath
      )
    );

  }

  const cargoTomlPath = 'services/rust-bridge/Cargo.toml';
  updates.set(cargoTomlPath, replacePackageVersionInToml(load(cargoTomlPath), version, cargoTomlPath));

  const cargoLockPath = 'services/rust-bridge/Cargo.lock';
  updates.set(cargoLockPath, replacePackageVersionInCargoLock(load(cargoLockPath), version, cargoLockPath));

  updateJson('package-lock.json', (value) => {
    const packageEntries = value.packages;
    if (!packageEntries?.[''] || !packageEntries['apps/mobile']) {
      throw new Error('package-lock.json is missing required root or mobile workspace metadata.');
    }
    value.version = version;
    packageEntries[''].version = version;
    packageEntries['apps/mobile'].version = version;
  });

  updateJson('apps/mobile/app.json', (value) => {
    if (!value.expo || typeof value.expo !== 'object') {
      throw new Error('apps/mobile/app.json is missing expo config.');
    }
    value.expo.version = mobileVersion;
    if (value.expo.ios && Object.hasOwn(value.expo.ios, 'version')) {
      value.expo.ios.version = mobileVersion;
    }
    if (value.expo.android && Object.hasOwn(value.expo.android, 'version')) {
      value.expo.android.version = mobileVersion;
    }
  });

  const iosRoot = path.join(rootDir, 'apps/mobile/ios');
  if (fs.existsSync(iosRoot)) {
    const infoPlistPath = 'apps/mobile/ios/TetherCodeMobile/Info.plist';
    const infoPlist = load(infoPlistPath);
    updates.set(infoPlistPath, replaceExactly(
      infoPlist,
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/g,
      `$1${mobileVersion}$3`,
      infoPlistPath,
      'CFBundleShortVersionString'
    ));

    const xcodeProjectPath = 'apps/mobile/ios/TetherCodeMobile.xcodeproj/project.pbxproj';
    const xcodeProject = load(xcodeProjectPath);
    updates.set(xcodeProjectPath, replaceExactly(
      xcodeProject,
      /MARKETING_VERSION = [^;]+;/g,
      `MARKETING_VERSION = ${mobileVersion};`,
      xcodeProjectPath,
      'MARKETING_VERSION'
    ));
  }

  const androidRoot = path.join(rootDir, 'apps/mobile/android');
  if (fs.existsSync(androidRoot)) {
    const buildGradlePath = 'apps/mobile/android/app/build.gradle';
    const buildGradle = load(buildGradlePath);
    updates.set(buildGradlePath, replaceExactly(
      buildGradle,
      /versionName\s+"[^"]+"/g,
      `versionName "${mobileVersion}"`,
      buildGradlePath,
      'versionName'
    ));
  }

  return { mobileVersion, sources, updates, version };
}

function syncVersions({ rootDir = defaultRootDir, check = false } = {}) {
  const result = collectVersionUpdates(rootDir);
  const changedPaths = [...result.updates]
    .filter(([relativePath, next]) => result.sources.get(relativePath) !== next)
    .map(([relativePath]) => relativePath);

  if (check && changedPaths.length > 0) {
    throw new Error(`Version metadata is out of sync with package.json (${result.version}):\n- ${changedPaths.join('\n- ')}`);
  }

  if (!check) {
    const writtenPaths = [];
    try {
      for (const relativePath of changedPaths) {
        writtenPaths.push(relativePath);
        fs.writeFileSync(path.join(rootDir, relativePath), result.updates.get(relativePath));
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const relativePath of writtenPaths.reverse()) {
        try {
          fs.writeFileSync(path.join(rootDir, relativePath), result.sources.get(relativePath));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Version synchronization failed and rollback was incomplete.'
        );
      }
      throw error;
    }
  }

  return { ...result, changedPaths };
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const result = syncVersions({ check });
  if (check) {
    console.log(`Version metadata is synchronized to ${result.version}.`);
  } else {
    console.log(`Synchronized package version ${result.version} and mobile version ${result.mobileVersion}.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}

module.exports = { syncVersions };
