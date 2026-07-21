#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT_DIR/services/rust-bridge"
TOOLCHAIN="nightly-2026-07-15"
REPORT_DIR="$BRIDGE_DIR/target/llvm-cov"

if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  echo "Missing Rust coverage toolchain. Install it with:" >&2
  echo "  rustup toolchain install ${TOOLCHAIN} --profile minimal --component llvm-tools-preview" >&2
  exit 1
fi
if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "Missing cargo-llvm-cov. Install it with:" >&2
  echo "  cargo install cargo-llvm-cov@0.8.7 --locked" >&2
  exit 1
fi

mkdir -p "$REPORT_DIR"
(
  cd "$BRIDGE_DIR"
  cargo "+${TOOLCHAIN}" llvm-cov test \
    --locked \
    --bin codex-rust-bridge \
    --branch \
    --json \
    --summary-only \
    --output-path "$REPORT_DIR/coverage.json" \
    -- \
    --test-threads=1
  cargo "+${TOOLCHAIN}" llvm-cov report \
    --branch \
    --html \
    --output-dir "$REPORT_DIR/html"
)

node "$ROOT_DIR/scripts/check-rust-coverage.mjs" "$REPORT_DIR/coverage.json"
