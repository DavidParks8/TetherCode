#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex < 0 || !argv[outputIndex + 1]) {
    throw new Error('Usage: generate-desktop-notices.mjs --output <path>');
  }
  return { output: path.resolve(argv[outputIndex + 1]) };
}

function licenseFiles(packageRoot) {
  const files = [];
  for (const name of readdirSync(packageRoot)) {
    const fullPath = path.join(packageRoot, name);
    if (statSync(fullPath).isFile() && /^(license|licence|copying|notice|copyright)(\.|$)/i.test(name)) {
      files.push(fullPath);
    }
  }
  const licenses = path.join(packageRoot, 'LICENSES');
  if (existsSync(licenses)) {
    for (const name of readdirSync(licenses)) {
      const fullPath = path.join(licenses, name);
      if (statSync(fullPath).isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function collectCargoPackages(rootDir, manifestPath) {
  const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Could not determine Rust host target');
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata', '--locked', '--format-version', '1', '--filter-platform', host,
    '--manifest-path', path.join(rootDir, manifestPath),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const pending = [metadata.resolve.root];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const dependency of nodeById.get(id)?.deps ?? []) pending.push(dependency.pkg);
  }
  return [...visited]
    .map((id) => packageById.get(id))
    .filter((pkg) => pkg?.source)
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || 'See included license text',
      root: path.dirname(pkg.manifest_path),
    }));
}

function generate(rootDir) {
  const packages = [
    ...collectCargoPackages(rootDir, 'apps/desktop/Cargo.toml'),
    ...collectCargoPackages(rootDir, 'services/rust-bridge/Cargo.toml'),
  ]
    .filter((pkg, index, all) => all.findIndex((candidate) => candidate.name === pkg.name && candidate.version === pkg.version) === index)
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

  const groups = new Map();
  for (const pkg of packages) {
    const label = `${pkg.name} ${pkg.version}`;
    for (const file of licenseFiles(pkg.root)) {
      const text = readFileSync(file, 'utf8').trim();
      if (!text) continue;
      const digest = createHash('sha256').update(text).digest('hex');
      const group = groups.get(digest) ?? { packages: [], text };
      group.packages.push(label);
      groups.set(digest, group);
    }
  }

  const lines = [
    'TetherCode Desktop Third-Party Notices', '',
    'The macOS application uses operating-system SwiftUI/AppKit frameworks and bundles only Rust executables.', '',
    'Bundled Rust packages:', '',
    ...packages.map((pkg) => `- ${pkg.name} ${pkg.version} (${pkg.license})`),
    '', 'License Texts', '=============',
  ];
  for (const group of [...groups.values()].sort((left, right) => left.packages[0].localeCompare(right.packages[0]))) {
    lines.push('', '------------------------------------------------------------');
    lines.push(`Applies to: ${[...new Set(group.packages)].sort().join(', ')}`);
    lines.push('------------------------------------------------------------', '', group.text);
  }
  return `${lines.join('\n')}\n`;
}

const { output } = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(import.meta.dirname, '..');
writeFileSync(output, generate(rootDir));
console.log(output);
