# ShadeGuard

> **The agent requests. ShadeGuard enforces. Zcash shields.**

ShadeGuard is a privacy and permission gateway for AI agents that use Zcash wallets through the Model Context Protocol (MCP). It gives an agent only the information and authority required for one task, then sends an approved payment through a real shielded Zcash testnet wallet.

**Status:** working testnet MVP. A real MCP-controlled shielded transfer and the complete HTTP 402 paid-API flow were accepted on Zcash testnet on 17 August 2026. The transaction evidence is recorded in [live acceptance](docs/live-acceptance.md).

<!-- Add the final public demo-video URL here before the global submission. -->

## The problem

Zcash protects transaction details on-chain, but an over-privileged AI agent can break privacy before a transaction reaches the chain. A wallet integration may reveal an exact balance, complete transaction history, viewing keys, sensitive memo text, or a broad raw tool surface when the task only requires one payment.

ShadeGuard places an enforceable boundary between the agent and the wallet:

| Agent request | ShadeGuard behavior |
| --- | --- |
| “What is the wallet balance?” | Rewrites the request to `can_afford(amount)` and returns one boolean. |
| “Export the viewing/spending key.” | Denies the request as critical risk. |
| “Show every transaction.” | Denies full history; permits status for one known payment ID. |
| “Send with my email in the memo.” | Removes the sensitive memo locally and requires acceptance of the safe rewrite. |
| “Pay this service.” | Enforces network, recipient, per-payment, daily-budget, and approval rules before execution. |

The LLM is an intent interpreter, not a security authority. `ALLOW`, `DENY`, `REWRITE`, and `REQUIRE_APPROVAL` are produced only by the deterministic, fail-closed policy engine.

## How it works

```text
User task / MCP host
        |
        v
Untrusted intent proposal       Sensitive memo remains local
        |
        v
ShadeGuard MCP Gateway
        |
        v
Canonical request -> deterministic policy -> privacy-safe audit
        |                         |
        |                         +-- DENY / REWRITE / REQUIRE_APPROVAL
        v
Reviewed safe capability
        |
        +-- Zingo CLI adapter ----------> Zcash testnet
        +-- Allowlisted downstream MCP -> Zcash provider
```

The upstream MCP server exposes only five reviewed tools:

- `shadeguard_can_afford`
- `shadeguard_safe_send`
- `shadeguard_get_payment_status`
- `shadeguard_get_receive_address`
- `shadeguard_resume_approved_payment`

Raw downstream tools are never mirrored upstream. Exact balance, full history, notes, seed material, private keys, and viewing keys have no executable MCP mapping.

## What the demo proves

The retro mobile interface is an explainability console, not a replacement wallet. It makes normally invisible intent, policy, approval, wallet, and audit boundaries understandable in a short video. It defaults to English for global visitors and includes a persistent `TR / EN` language switch.

1. Ask whether `0.01 TAZ` is affordable and receive only `true` or `false`.
2. Request a viewing key and observe a deterministic critical denial.
3. Obtain a receive address from the real local Zingo testnet wallet.
4. Include an email in a memo and observe a memo-free rewrite without automatic execution.
5. Query one known TXID rather than exposing the wallet's complete history.
6. Inspect decision, risk, reason code, capability, and sanitized audit data.

Natural-language analysis is preview-only. It never triggers a wallet action. Real wallet calls are separate, typed user actions in the Wallet tab or reviewed MCP tool calls.

| Component | Current implementation |
| --- | --- |
| Policy, approval, spend ledger, and audit | Real local implementation |
| Intent interpretation | NVIDIA NIM with `meta/llama-3.1-8b-instruct`; deterministic local fallback if unavailable |
| Web wallet data | Real Zingo testnet data; fails closed when Zingo is unavailable |
| Payment and task-scoped status | Real shielded Zcash testnet transaction |
| Mock provider | Used only by isolated automated tests and the non-live CLI demo |

## Why Zcash matters

Zcash and ShadeGuard protect two different boundaries:

- **ShadeGuard protects the application boundary:** what the agent may know, request, and execute.
- **Zcash protects the chain boundary:** shielded transaction details are not published as transparent transaction data.

The wallet path uses an Ironwood-compatible Zingo CLI light client. Ironwood reuses the Orchard protocol's action, key, and zero-knowledge proof structure while maintaining a separate note commitment tree and nullifier set. [Halo 2](https://zcash.github.io/halo2/) supplies the proof system; note commitments bind private note data, and nullifiers prevent double-spending without revealing which note was spent. See the [Ironwood concepts](https://zcash.github.io/ironwood/concepts.html) for the protocol details.

A TXID is a public chain reference, not a wallet secret. ShadeGuard uses it to request only the status of the payment already known to the task. It does not return the wallet's transaction list. TAZ is testnet-only and has no economic value.

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/core` | Canonical capability model, amount parsing, privacy checks, deterministic policy, and audit redaction |
| `packages/ai-adapter` | NVIDIA NIM structured intent proposal and no-key deterministic fallback |
| `packages/mcp-gateway` | Safe MCP registry, execution pipeline, approvals, audit, and persistent spend ledger |
| `packages/zcash-adapter` | Minimal provider interface, Zingo CLI, allowlisted downstream MCP, and test double |
| `packages/approval-service` | Request-bound, expiring, single-use approvals |
| `apps/retro-console` | Local demo and explainability interface |
| `apps/demo-agent` | Reproducible MCP policy and testnet acceptance client |
| `apps/demo-paid-api` | HTTP 402 merchant service and payment client |
| `docs` | Architecture, threat model, wallet setup, and real-chain evidence |

The policy engine depends on canonical capabilities rather than Zingo commands or provider-specific MCP tool names. A provider can therefore change without moving security decisions into the adapter.

## Quick start

### 1. Verify the policy and MCP layers

Requirements: Node.js 22+ and Corepack/pnpm. These checks do not require an API key, Zingo, a faucet, or network funds.

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm demo
```

`pnpm demo` deliberately uses the test provider. It verifies the safe MCP tool list, minimum-information response, PII memo rewrite, accepted rewrite, and task-scoped status without spending TAZ.

### 2. Build the testnet wallet client

The accepted live path uses Zingo's official Ironwood beta at commit `f48b15c9ed5676fcce92ad51b1e2a7eecbc8e36d`. Building it requires Rust 1.91, a C/C++ build toolchain, and Protocol Buffers (`protoc`).

```bash
mkdir -p .shadeguard
git clone https://github.com/zingolabs/zingolib.git .shadeguard/zingolib
git -C .shadeguard/zingolib checkout f48b15c9ed5676fcce92ad51b1e2a7eecbc8e36d
(cd .shadeguard/zingolib && cargo +1.91.0 build --release --locked -p zingo-cli)
```

Create the local configuration:

```bash
cp .env.example .env
pnpm zingo:check
```

The default paths are already aligned with that build:

```dotenv
SHADEGUARD_MODE=zingo
SHADEGUARD_NETWORK=testnet
ZINGO_CLI_PATH=.shadeguard/zingolib/target/release/zingo-cli
ZINGO_DATA_DIR=.shadeguard/zingo-testnet
ZINGO_SERVER_URL=https://testnet.zec.rocks:443
```

The first wallet operation creates one persistent, testnet-only wallet under `.shadeguard/zingo-testnet`. It is not recreated on every launch. Never place a seed phrase, private key, spending key, or viewing key in `.env`, the browser, an issue, or an AI prompt.

### 3. Run the explainability console

```bash
pnpm web
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Use the receive-address action, fund that address with TAZ from a currently available Zcash testnet faucet, and wait for Zingo to sync before testing a payment.

NVIDIA NIM is optional. To reproduce the hosted intent interpretation shown in the demo, configure the following server-side values in `.env`:

```dotenv
AI_PROVIDER=nvidia
NVIDIA_MODEL=meta/llama-3.1-8b-instruct
NVIDIA_API_KEY=
```

The key is never bundled into browser assets or written to the audit log. Without a key—or if NIM is temporarily unavailable—the local deterministic interpreter keeps policy demonstrations working. It still cannot authorize an operation.

## Reproduce the real testnet flows

These commands use external infrastructure and can spend TAZ. They require an explicitly funded wallet and opt-in environment variables.

### MCP shielded payment

```bash
SHADEGUARD_DEMO_RECIPIENT='utest1…' \
RUN_ZCASH_TESTNET_SEND=1 \
pnpm demo:testnet
```

To query an already known payment without broadcasting another transaction:

```bash
SHADEGUARD_DEMO_PAYMENT_ID='<64-character txid>' pnpm demo:testnet:status
```

### HTTP 402 paid API

This is an application example protected by ShadeGuard, not a new payment standard. Configure a second local Zingo wallet as the merchant with `PAID_API_RECIPIENT` and `PAID_API_ZINGO_DATA_DIR` in `.env`.

```bash
# Terminal 1: merchant
pnpm paid-api

# Terminal 2: paying agent
RUN_ZCASH_TESTNET_SEND=1 pnpm paid-api:client
```

The merchant first returns `402 PAYMENT_REQUIRED`. The client uses ShadeGuard to check affordability, submit a shielded payment, track only that TXID, and retry the endpoint. The merchant unlocks the response only after the transaction is confirmed and visible as an incoming payment of at least the requested amount in its own wallet.

Resume verification after an interrupted broadcast without paying twice:

```bash
PAID_API_PAYMENT_ID='<64-character txid>' pnpm paid-api:client
```

## Security scope

This release is intentionally testnet-only and localhost-only. Mainnet, public multi-user hosting, and unrestricted wallet access are technically rejected. The current approval store is single-process, and a remote Zingo indexer can still observe network/timing metadata. ShadeGuard has not received an independent security audit and must not be used with real funds.

The web runtime requires a long-running Node process, a local Zingo binary, and persistent wallet storage. A static or serverless Vercel deployment cannot run the complete wallet flow by itself.

For the exact guarantees and residual risks, see:

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Zingo testnet setup](docs/zingo.md)
- [Live testnet acceptance evidence](docs/live-acceptance.md)

## Türkçe özet

> **Agent ister. ShadeGuard denetler. Zcash gizler.**

Zcash, onaylanmış bir shielded işlemin finansal ayrıntılarını zincir üzerinde korur. ShadeGuard ise işlem zincire ulaşmadan önce agentın hangi cüzdan bilgisini öğrenebileceğini ve hangi yetkiyi kullanabileceğini sınırlar.

Tam bakiye yerine yalnızca belirli bir tutarın yeterli olup olmadığını döndürür; viewing/spending key ve tüm işlem geçmişi taleplerini reddeder; hassas memo içeriğini yerelde kaldırır; testnet, shielded alıcı, harcama limiti ve kullanıcı onayı kurallarını deterministik olarak uygular. NVIDIA NIM yalnız doğal dili yapılandırılmış niyete dönüştürür, güvenlik kararı vermez.

Frontend ürünün kendisi değil, bu görünmez güvenlik kararlarını demo videosunda anlaşılır hale getiren yerel bir açıklama konsoludur. Gerçek ödeme akışı Zingo CLI üzerinden Zcash testnet'e gider. MCP kontrollü shielded transfer ve HTTP 402 ücretli API senaryosu gerçek TAZ ile uçtan uca tamamlanmıştır.

Hızlı kod doğrulaması için `pnpm install`, `pnpm typecheck`, `pnpm test` ve `pnpm demo`; gerçek wallet demosu için yukarıdaki Zingo kurulumu ve `pnpm web` adımları izlenir. Proje şu anda yalnız testnet ve localhost kapsamındadır; mainnet veya gerçek fonlar için hazır değildir.

## License

MIT
