import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = path.join(root, 'apps/mobile');
const mobilePackage = JSON.parse(readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'));
const dependencyNames = Object.keys({
  ...mobilePackage.dependencies,
  ...mobilePackage.devDependencies,
});
const forbiddenDependencyPatterns = [
  /^react-native-purchases(?:-ui)?$/,
  /^@revenuecat\//,
];

for (const dependencyName of dependencyNames) {
  if (forbiddenDependencyPatterns.some((pattern) => pattern.test(dependencyName))) {
    throw new Error(`Payment isolation check failed: forbidden mobile dependency ${dependencyName}`);
  }
}

const sourceFiles = [
  path.join(root, 'package-lock.json'),
  path.join(mobileRoot, '.env.example'),
  path.join(mobileRoot, 'App.tsx'),
  path.join(mobileRoot, 'app.json'),
  path.join(mobileRoot, 'eas.json'),
  ...walkSourceFiles(path.join(mobileRoot, 'src')),
];
const forbiddenMarkers = [
  'EXPO_PUBLIC_' + 'REVENUECAT',
  'react-native-' + 'purchases',
  '@' + 'revenuecat',
  'Purchases' + '.configure',
  'purchase' + 'Package(',
  'present' + 'Paywall(',
];

for (const file of sourceFiles) {
  const content = readFileSync(file, 'utf8').toLowerCase();
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker.toLowerCase())) {
      throw new Error(
        `Payment isolation check failed: ${path.relative(root, file)} contains ${marker}`
      );
    }
  }
}

process.stdout.write('Payment isolation is clean: no purchase SDK or provider configuration found.\n');

function walkSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkSourceFiles(entryPath);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}
