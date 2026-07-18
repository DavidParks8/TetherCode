import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractBridgeHttpRoutes,
  extractNativeBridgeMethods,
  findRustFunctionSource,
} from '../rust-bridge-source-inventory.mjs';

test('extracts grouped native bridge match arms without notification strings', () => {
  const sources = new Map([['transport.rs', `
    async fn handle_bridge_method(method: &str) {
      match method {
        "bridge/one" => notify("bridge/notification"),
        "bridge/two" | "bridge/three" => {},
        _ => {},
      }
    }

    async fn next_function() {}
  `]]);

  assert.deepEqual(extractNativeBridgeMethods(sources), [
    'bridge/one',
    'bridge/two',
    'bridge/three',
  ]);
});

test('extracts only routes owned by the bridge router', () => {
  const sources = new Map([['routes.rs', `
    fn build_bridge_router() {
      Router::new()
        .route("/rpc", get(ws))
        .route(
          "/attachments",
          post(upload),
        );
    }

    fn build_preview_router() {
      Router::new().route("/", get(preview));
    }
  `]]);

  assert.deepEqual(extractBridgeHttpRoutes(sources), ['/rpc', '/attachments']);
  assert.equal(findRustFunctionSource(sources, 'build_bridge_router').file, 'routes.rs');
  assert.throws(
    () => findRustFunctionSource(sources, 'missing'),
    /Rust function not found: missing/,
  );
});
