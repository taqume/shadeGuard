# Zingo CLI adapter

ShadeGuard's preferred real testnet path is:

```text
Retro Console / MCP Agent
          |
          v
Deterministic Policy Engine
          |
          v
ZingoCliProvider -- argument-vector subprocess --> zingo-cli (Ironwood beta)
                                                   |
                                                   v
                                         Zcash testnet indexer
```

## Why Zingo?

Zingo CLI is a light wallet, so it does not require a local full-node sync. Wallet keys remain inside the local Zingo data directory. The tradeoff is that the selected indexer can observe the client's IP address, timing, and block-access metadata that may correlate with shielded activity. This network-metadata boundary is separate from Zcash's on-chain privacy.

The adapter uses only this reviewed command contract:

- `spendable_balance`: reduced to a boolean inside the adapter;
- `addresses`: returns one testnet shielded receive address;
- `quicksend`: called only after deterministic policy and any required approval;
- `transactions`: searched internally for one known TXID; the raw list never reaches the agent.

ShadeGuard does not expose `recovery_info`, `export_ufvk`, `messages`, `notes`, `value_transfers`, or raw command passthrough.

## Execution controls

The CLI is launched with `shell: false` and an argument vector. The recipient is validated again as testnet and shielded. Output size and execution time are bounded, raw stderr is not copied into agent/audit responses, and wallet commands are serialized to avoid concurrent file access.

Defaults:

```dotenv
SHADEGUARD_MODE=zingo
ZINGO_CLI_PATH=.shadeguard/zingolib/target/release/zingo-cli
ZINGO_DATA_DIR=.shadeguard/zingo-testnet
ZINGO_SERVER_URL=https://testnet.zec.rocks:443
ZINGO_WAIT_FOR_SYNC=true
```

`ZINGO_SERVER_URL` must use HTTPS; HTTP is accepted only for a loopback address. Mainnet is rejected by the runtime.

## Build and verify

The live acceptance used official Zingo commit `f48b15c9ed5676fcce92ad51b1e2a7eecbc8e36d` from the `zingolib_beta_ironwood` line. See the root [README](../README.md#2-build-the-testnet-wallet-client) for the exact source-build steps.

```bash
pnpm zingo:check
pnpm web
```

A receive-address or payment operation can wait for the light wallet to sync. This is not a full Zebra chain sync, but it still depends on an external indexer and is intentionally excluded from the normal automated test suite.

## Persistent wallet and test funds

`.shadeguard/zingo-testnet` is one persistent development wallet. It is not recreated at startup and ShadeGuard does not automatically request faucet funds. Use the receive-address operation, then fund it from a currently available Zcash testnet faucet. Faucet availability and rate limits are external to ShadeGuard and do not block policy-only tests.

Wallet material under `.shadeguard/` is ignored by Git. Never copy a seed phrase, private key, spending key, or viewing key into `.env`, the frontend, an issue, or an AI prompt.
