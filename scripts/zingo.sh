#!/usr/bin/env bash
set -euo pipefail

SG_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SG_ROOT="$(cd "$SG_SCRIPT_DIR/.." && pwd)"
SG_ZINGO_BIN="${ZINGO_CLI_PATH:-zingo-cli}"
SG_ZINGO_DATA="${ZINGO_DATA_DIR:-$SG_ROOT/.shadeguard/zingo-testnet}"
SG_ZINGO_SERVER="${ZINGO_SERVER_URL:-https://testnet.zec.rocks:443}"

die() {
  printf 'ShadeGuard Zingo: %s\n' "$*" >&2
  exit 1
}

check() {
  command -v "$SG_ZINGO_BIN" >/dev/null 2>&1 || {
    printf 'Zingo CLI was not found: %s\n' "$SG_ZINGO_BIN"
    printf 'ShadeGuard will not substitute fake wallet data; wallet operations fail closed.\n'
    printf 'Pinned source setup: see the Quick start section in README.md\n'
    exit 2
  }
  local version
  version="$("$SG_ZINGO_BIN" --version 2>/dev/null)" || die "binary çalıştırılamadı"
  printf 'Zingo CLI: %s\n' "$version"
  printf 'Network: testnet\n'
  printf 'Indexer: %s\n' "$SG_ZINGO_SERVER"
  printf 'Wallet directory: %s\n' "$SG_ZINGO_DATA"
}

case "${1:-check}" in
  check) check ;;
  *) die "usage: scripts/zingo.sh check" ;;
esac
