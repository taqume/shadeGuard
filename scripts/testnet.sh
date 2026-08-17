#!/usr/bin/env bash
set -euo pipefail

SG_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SG_ROOT="$(cd "$SG_SCRIPT_DIR/.." && pwd)"
SG_STATE_DIR="$SG_ROOT/.shadeguard/testnet"
SG_Z3_DIR="$SG_ROOT/.shadeguard/z3"
SG_Z3_COMMIT="e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb"
SG_Z3_REPOSITORY="https://github.com/ZcashFoundation/z3.git"
SG_Z3_ENV="$SG_STATE_DIR/z3.env"
SG_OVERLAY="$SG_ROOT/infra/z3/docker-compose.shadeguard.yml"
SG_ZALLET_VOLUME="z3-testnet-zallet"
SG_BUSYBOX_IMAGE="busybox:1.37.0@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0"
SG_ZEBRA_IMAGE="zfnd/zebra:6.3.0@sha256:52a67e543906c98a0ed1599e2ce3ee238fc05b40592ae26ee5914ddb6ede51e3"
SG_ZALLET_IMAGE="zodlinc/zallet:v0.1.0-beta.2@sha256:b30ca91a9a7c83d8eae44c4ba19b5dd3dad377f05ed53aeaff9430d93067f99d"
SG_DOCKER="${DOCKER:-docker}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ShadeGuard testnet: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

compose() {
  "$SG_DOCKER" compose \
    --project-directory "$SG_Z3_DIR" \
    --env-file "$SG_Z3_ENV" \
    -f "$SG_Z3_DIR/docker-compose.yml" \
    -f "$SG_OVERLAY" \
    "$@"
}

setup_z3() {
  require_command git
  require_command "$SG_DOCKER"
  require_command jq
  require_command curl
  mkdir -p "$SG_STATE_DIR"

  if [ ! -d "$SG_Z3_DIR/.git" ]; then
    log "==> Cloning the pinned official Z3 stack..."
    git clone --filter=blob:none "$SG_Z3_REPOSITORY" "$SG_Z3_DIR"
  fi

  local origin
  origin="$(git -C "$SG_Z3_DIR" remote get-url origin)"
  [ "$origin" = "$SG_Z3_REPOSITORY" ] || die "managed Z3 directory has an unexpected origin: $origin"
  if [ -n "$(git -C "$SG_Z3_DIR" status --porcelain)" ]; then
    die "managed Z3 checkout has local changes; inspect $SG_Z3_DIR before continuing"
  fi

  git -C "$SG_Z3_DIR" fetch --depth 1 origin "$SG_Z3_COMMIT"
  git -C "$SG_Z3_DIR" checkout --detach "$SG_Z3_COMMIT" >/dev/null
  [ "$(git -C "$SG_Z3_DIR" rev-parse HEAD)" = "$SG_Z3_COMMIT" ] || die "Z3 commit verification failed"

  "$SG_Z3_DIR/scripts/setup-network.sh" testnet
  perl -pi -e 's/as_of_version = "0\.1\.0-beta\.1"/as_of_version = "0.1.0-beta.2"/' \
    "$SG_Z3_DIR/config/testnet/zallet.toml"

  cp "$SG_Z3_DIR/.env.testnet" "$SG_Z3_ENV"
  {
    printf '\n# ShadeGuard-reviewed image pins.\n'
    printf 'Z3_ZEBRA_IMAGE=%s\n' "$SG_ZEBRA_IMAGE"
    printf 'Z3_ZALLET_IMAGE=%s\n' "$SG_ZALLET_IMAGE"
  } >> "$SG_Z3_ENV"

  compose config --quiet
  log "==> Z3 testnet configuration is ready at $SG_Z3_DIR"
}

start_zebra() {
  setup_z3
  log "==> Starting pinned Zebra testnet node..."
  compose up -d zebra
  log "Zebra is syncing. Public testnet sync commonly takes 2-12 hours."
  log "Check progress with: pnpm testnet:status"
  log "After Zebra is healthy, run: pnpm testnet:wallet"
}

zebra_health() {
  local container
  container="$(compose ps -q zebra 2>/dev/null || true)"
  if [ -z "$container" ]; then
    printf 'not-started'
    return
  fi
  "$SG_DOCKER" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container"
}

prepare_wallet_volume() {
  "$SG_DOCKER" run --rm -v "$SG_ZALLET_VOLUME:/data" "$SG_BUSYBOX_IMAGE" \
    sh -c 'touch /data/.z3-volume-initialized && chown 1000:1000 /data /data/.z3-volume-initialized && rm -f /data/.lock'
}

initialize_wallet() {
  setup_z3
  log "==> Preparing local, testnet-only Zallet encrypted storage..."
  prepare_wallet_volume

  local initialized
  initialized="$("$SG_DOCKER" run --rm -v "$SG_ZALLET_VOLUME:/data" "$SG_BUSYBOX_IMAGE" \
    sh -c 'find /data -maxdepth 1 -name "*.age" -type f | head -n 1')"
  if [ -n "$initialized" ]; then
    log "==> Testnet wallet material already exists; leaving it untouched."
  else
    "$SG_DOCKER" run --rm -v "$SG_ZALLET_VOLUME:/data" "$SG_BUSYBOX_IMAGE" rm -f /data/wallet.db
    local identity
    identity="$("$SG_DOCKER" run --rm -v "$SG_ZALLET_VOLUME:/data" "$SG_BUSYBOX_IMAGE" \
      sh -c 'test -f /data/identity.txt && echo present || true')"
    if [ "$identity" != "present" ]; then
      compose run --rm --no-deps zallet \
        --datadir /var/lib/zallet --config /etc/zallet/zallet.toml generate-encryption-identity
    fi
    compose run --rm --no-deps zallet \
      --datadir /var/lib/zallet --config /etc/zallet/zallet.toml init-wallet-encryption
    compose run --rm --no-deps zallet \
      --datadir /var/lib/zallet --config /etc/zallet/zallet.toml generate-mnemonic
    log "==> A testnet-only mnemonic was generated and encrypted inside the Docker volume."
  fi
}

refresh_cookie() {
  mkdir -p "$SG_STATE_DIR"
  umask 077
  local temporary="$SG_STATE_DIR/zallet.cookie.tmp"
  "$SG_DOCKER" run --rm -v "$SG_ZALLET_VOLUME:/data:ro" "$SG_BUSYBOX_IMAGE" \
    cat /data/.cookie > "$temporary" 2>/dev/null || {
      rm -f "$temporary"
      return 1
    }
  grep -q '^__cookie__:' "$temporary" || {
    rm -f "$temporary"
    return 1
  }
  mv "$temporary" "$SG_STATE_DIR/zallet.cookie"
  chmod 600 "$SG_STATE_DIR/zallet.cookie"
}

rpc_call() {
  local method="$1"
  local params="$2"
  local auth
  auth="$(tr -d '\r\n' < "$SG_STATE_DIR/zallet.cookie")"
  curl --silent --show-error --fail \
    --user "$auth" \
    --header 'content-type: application/json' \
    --data "$(jq -cn --arg method "$method" --argjson params "$params" '{jsonrpc:"2.0",id:1,method:$method,params:$params}')" \
    http://127.0.0.1:40232
}

wait_for_zallet() {
  local attempt response
  for attempt in $(seq 1 120); do
    if refresh_cookie; then
      response="$(rpc_call rpc.discover '[]' 2>/dev/null || true)"
      if jq -e '.result.methods | type == "array"' >/dev/null 2>&1 <<< "$response"; then
        return 0
      fi
    fi
    sleep 5
  done
  die "Zallet RPC did not become ready within 10 minutes"
}

configure_wallet() {
  wait_for_zallet
  local accounts account_id create_response address_response address
  accounts="$(rpc_call z_listaccounts '[false]')"
  account_id="$(jq -er '.result[]? | select(.name == "shadeguard-testnet") | .account_uuid' <<< "$accounts" | head -n 1 || true)"

  if [ -z "$account_id" ]; then
    create_response="$(rpc_call z_getnewaccount '["shadeguard-testnet"]')"
    if jq -e '.error != null' >/dev/null 2>&1 <<< "$create_response"; then
      die "Zallet could not create the ShadeGuard account yet; wait for wallet sync and retry"
    fi
    account_id="$(jq -er '.result.account_uuid' <<< "$create_response")"
  fi

  address_response="$(rpc_call z_getaddressforaccount "[\"$account_id\",[\"orchard\",\"sapling\"]]")"
  address="$(jq -er '.result.address' <<< "$address_response")"
  case "$address" in
    utest1*|ztestsapling*) ;;
    *) die "Zallet did not return a verified testnet shielded address" ;;
  esac

  umask 077
  printf '%s\n' "$account_id" > "$SG_STATE_DIR/account-id"
  printf '%s\n' "$address" > "$SG_STATE_DIR/receive-address"
  {
    printf 'SHADEGUARD_MODE=zallet\n'
    printf 'SHADEGUARD_NETWORK=testnet\n'
    printf 'SHADEGUARD_AUDIT_PATH=%s\n' "$SG_ROOT/.shadeguard/testnet/audit.jsonl"
    printf 'SHADEGUARD_SPEND_LEDGER_PATH=%s\n' "$SG_ROOT/.shadeguard/testnet/spend-ledger.jsonl"
    printf 'ZALLET_RPC_URL=http://127.0.0.1:40232\n'
    printf 'ZALLET_RPC_COOKIE_PATH=%s\n' "$SG_STATE_DIR/zallet.cookie"
    printf 'ZALLET_ACCOUNT_ID=%s\n' "$account_id"
    printf 'ZALLET_FUND_SOURCE=orchard\n'
  } > "$SG_STATE_DIR/shadeguard.env"
  chmod 600 "$SG_STATE_DIR/shadeguard.env"

  log "==> ShadeGuard testnet wallet is ready for funding."
  log "Testnet shielded receive address: $address"
  log "No seed phrase or wallet key left local encrypted storage."
}

start_wallet() {
  initialize_wallet
  local health
  health="$(zebra_health)"
  if [ "$health" != "healthy" ]; then
    die "Zebra health is '$health'. Wallet material is initialized; retry pnpm testnet:wallet after sync."
  fi
  log "==> Starting pinned Zallet beta.2 with its Zaino backend..."
  compose up -d cookie-permissions zallet
  configure_wallet
}

show_status() {
  if [ ! -f "$SG_Z3_ENV" ]; then
    log "Z3 is not configured. Run: pnpm testnet:setup"
    return
  fi
  compose ps
  log "Zebra health: $(zebra_health)"
  if [ -f "$SG_STATE_DIR/receive-address" ]; then
    log "Receive address: $(tr -d '\r\n' < "$SG_STATE_DIR/receive-address")"
  fi
}

show_receive_address() {
  [ -f "$SG_STATE_DIR/receive-address" ] || die "receive address is unavailable; run pnpm testnet:wallet after Zebra sync"
  tr -d '\r\n' < "$SG_STATE_DIR/receive-address"
  printf '\n'
}

run_mcp() {
  [ -f "$SG_STATE_DIR/shadeguard.env" ] || die "testnet wallet is not configured; run pnpm testnet:wallet first"
  refresh_cookie || die "Zallet cookie is unavailable; ensure the testnet stack is running"
  set -a
  # shellcheck disable=SC1090
  . "$SG_STATE_DIR/shadeguard.env"
  set +a
  exec node "$SG_ROOT/packages/mcp-gateway/dist/server.js"
}

run_testnet_tests() {
  [ -f "$SG_STATE_DIR/shadeguard.env" ] || die "testnet wallet is not configured; run pnpm testnet:wallet first"
  refresh_cookie || die "Zallet cookie is unavailable; ensure the testnet stack is running"
  set -a
  # shellcheck disable=SC1090
  . "$SG_STATE_DIR/shadeguard.env"
  set +a
  export RUN_ZCASH_TESTNET=1
  exec pnpm --dir "$SG_ROOT" --filter @shadeguard/zcash-adapter test -- testnet.integration.test.ts
}

usage() {
  printf 'Usage: %s <setup|up|status|wallet|receive|mcp|test>\n' "$0" >&2
  exit 2
}

case "${1:-}" in
  setup) setup_z3 ;;
  up) start_zebra ;;
  status) show_status ;;
  wallet) start_wallet ;;
  receive) show_receive_address ;;
  mcp) run_mcp ;;
  test) run_testnet_tests ;;
  *) usage ;;
esac
