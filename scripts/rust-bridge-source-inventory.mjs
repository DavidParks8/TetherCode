import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const TEST_ONLY_RUST_FILES = /^(?:boundary_integration|coverage_main_.+|main_tests)\.rs$/;

const walkRustSources = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkRustSources(entryPath);
    if (!entry.name.endsWith('.rs') || TEST_ONLY_RUST_FILES.test(entry.name)) return [];
    return [entryPath];
  });

export const readRustBridgeProductionSources = (root) => {
  const sourceRoot = path.join(root, 'services/rust-bridge/src');
  return new Map(walkRustSources(sourceRoot).map((file) => [
    path.relative(root, file),
    readFileSync(file, 'utf8'),
  ]));
};

export const findRustFunctionSource = (sources, functionName) => {
  const signature = new RegExp(`(?:pub\\(super\\)\\s+)?(?:async\\s+)?fn\\s+${functionName}\\s*\\(`);
  for (const [file, source] of sources) {
    const match = signature.exec(source);
    if (!match) continue;
    const remainder = source.slice(match.index + match[0].length);
    const nextFunction = /\n\s*(?:pub\(super\)\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+\s*\(/.exec(remainder);
    return {
      file,
      source: nextFunction ? remainder.slice(0, nextFunction.index) : remainder,
    };
  }
  throw new Error(`Rust function not found: ${functionName}`);
};

export const extractNativeBridgeMethods = (sources) => {
  const handler = findRustFunctionSource(sources, 'handle_bridge_method');
  return [...handler.source.matchAll(/"(bridge\/[^"]+)"(?=\s*(?:\||=>))/g)]
    .map((match) => match[1]);
};

export const extractBridgeHttpRoutes = (sources) => {
  const router = findRustFunctionSource(sources, 'build_bridge_router');
  return [...router.source.matchAll(/\.route\(\s*"([^"]+)"/g)]
    .map((match) => match[1]);
};
