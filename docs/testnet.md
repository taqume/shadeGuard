# Zcash testnet runbook

ShadeGuard uses the official Zcash Foundation **Z3** stack rather than maintaining a divergent wallet/node Compose file. The bootstrap script checks out a reviewed Z3 commit into ignored local storage and overlays host-local RPC bindings plus reviewed image pins:

- Z3 commit `e84ce9fd8e864ff0b2a8a62f6ce14392145db0fb`
- Zebra `6.3.0` (OCI digest pinned)
- Zallet `0.1.0-beta.2` (OCI digest pinned), using its embedded Zaino backend

No mainnet mode exists in these commands.

## 1. Start Zebra testnet sync

```bash
pnpm testnet:up
pnpm testnet:status
```

The public testnet sync can take 2–12 hours. The command returns after starting the container; it does not pretend that an unsynced node is ready.

## 2. Initialize the local testnet wallet

After status reports Zebra as `healthy`:

```bash
pnpm testnet:wallet
```

This command creates an age encryption identity, wallet encryption, and mnemonic inside the ignored `z3-testnet-zallet` Docker volume. It never prints or exports the mnemonic. It then creates a purpose-specific account and prints only its shielded testnet receive address.

The local cookie, account ID, and ShadeGuard environment pointer are written with restrictive permissions below `.shadeguard/testnet/`, which is gitignored.

## 3. Fund the address

```bash
pnpm testnet:receive
```

Use the printed address with a currently working Zcash testnet faucet. Faucet availability must be checked at the time of funding; do not hard-code an old URL. Zallet defaults require received notes to mature before spending, so wait for the required confirmations.

Never use a mainnet address or key. Never paste a seed phrase, spending key, or viewing key into chat or project files.

## 4. Start the real testnet MCP gateway

```bash
pnpm testnet:mcp
```

The MCP process reads Zallet's rotating local cookie, performs `rpc.discover`, verifies a testnet shielded source address, and enables only provider capabilities whose required RPC parameters are present. It refuses a send method without explicit `privacy_policy` support.

For an explicit real-transfer integration test, set all gated variables and run the adapter suite. The test does not broadcast unless `RUN_ZCASH_TESTNET_SEND=1` is deliberately provided.

## Operational notes

- Zallet and Zebra RPC ports bind to `127.0.0.1`; only Zebra P2P is publicly bound.
- Stop containers using the official Z3 Compose project if needed. Do not use `down -v` unless you intentionally want to destroy the encrypted wallet and chain volumes.
- The wallet volume is the only irreplaceable testnet state. Back it up before relying on it.
- Zallet is beta software. A successful capability probe is necessary but not sufficient; a real funded transfer remains the acceptance criterion.
