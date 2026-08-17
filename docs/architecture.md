# ShadeGuard architecture

## Mission and invariants

ShadeGuard is an MCP security gateway, not a wallet and not a generic payment protocol. Its product boundary is the runtime enforcement of:

1. **Least information:** return a task-scoped fact such as `can_afford(0.01)` instead of an exact wallet balance.
2. **Least authority:** expose a small, stable set of safe capabilities rather than mirroring downstream wallet tools.
3. **Privacy-preserving execution:** reject or rewrite technically valid operations that would weaken Zcash privacy.

The following invariants are architectural, not configuration defaults:

- An LLM never makes or overrides `ALLOW`, `DENY`, `REQUIRE_APPROVAL`, or `REWRITE` decisions.
- Unknown capabilities and unknown downstream tools fail closed.
- Mainnet is rejected by every MVP adapter.
- Secrets and exact wallet state cannot be serialized into agent, AI, or audit boundaries.
- A downstream provider change cannot require a policy-engine change.

## System context

```text
Retro web console / MCP host / AI agent
        |
        | safe MCP tools only
        v
ShadeGuard MCP server
        |
        v
Canonical request normalizer
        |
        +--> deterministic policy engine --> deny / rewrite / approval
        |                                      |
        |                                      +--> privacy-safe audit event
        v
Approval verifier (when required)
        |
        v
ZcashProvider interface
        |
        +--> Zingo CLI Ironwood beta (preferred testnet light-client path)
        +--> Zallet JSON-RPC (optional full-node path)
        +--> Downstream MCP client adapter (allowlisted provider-specific mapping)
        +--> Mock provider (tests only)
```

The gateway does not dynamically proxy `tools/list`. Its upstream registry is code-reviewed and contains only `can_afford`, `safe_send`, `get_payment_status`, a deliberately scoped receive-address operation, and a request-bound approval-resume operation. Provider discovery affects availability, never exposure of new tools.

## Packages

| Package | Responsibility | Must not know |
| --- | --- | --- |
| `shadeguard-core` | Canonical requests, risk model, deterministic policies, PII detection, redaction | RPC names, API keys, MCP transports |
| `approval-service` | Request-bound, expiring, one-use approvals | Wallet secrets, raw provider responses |
| `zcash-adapter` | Minimal provider interface, Zingo/Zallet/downstream implementations, test doubles | Agent prompts, policy decisions |
| `ai-adapter` | Gemini/NVIDIA NIM structured intent proposal and deterministic no-key fallback | Policy decisions, wallet state, execution |
| `mcp-gateway` | Safe MCP server, normalization and execution pipeline | Private keys, unrestricted downstream tool lists |
| `demo-agent` | Reproducible MCP client scenarios | Direct wallet connectivity |
| `retro-console` | Localhost-only natural-language, wallet and audit visualization | API keys in browser, direct wallet commands |

The `ai-adapter` transforms natural language into a restricted structured intent and supports a deterministic no-key fallback. The selected hosted provider receives the user's task instruction but no requester identity or wallet state. Explicit memo content is removed locally before the hosted request and reattached only at the canonical-policy boundary. Model output remains untrusted input to the same deterministic normalizer and policy engine. NVIDIA responses may contain numeric amounts, null optional fields, combined capabilities, or several JSON candidates; the adapter normalizes these mechanically and selects the highest-risk recognized capability before deterministic policy evaluation.

## Canonical execution model

Every request has an ID, requester context, purpose, capability, and only the fields relevant to that capability. Amounts are integer zatoshis; floating-point ZEC values are accepted only at input boundaries and converted using strict decimal parsing.

Canonical capabilities initially include:

- `CAN_AFFORD`
- `SEND_SHIELDED`
- `GET_PAYMENT_STATUS`
- `GET_RECEIVE_ADDRESS`
- `READ_EXACT_BALANCE`
- `LIST_TRANSACTIONS`
- `EXPORT_VIEWING_KEY`
- `EXPORT_SPENDING_KEY`
- `UNKNOWN`

The last five exist so the policy engine can explicitly model and test denied requests. They are not exposed as MCP tools.

## Decision pipeline

```text
validate -> normalize -> classify address/memo -> evaluate policy
  -> DENY: return reason code; never call provider
  -> REWRITE: return redacted safe alternative; execute only after explicit acceptance
  -> REQUIRE_APPROVAL: create call-bound approval; execute only once before expiry
  -> ALLOW: verify provider capability; execute minimal adapter call
  -> audit sanitized outcome
```

Policy results contain a machine-readable reason code, risk level, human explanation, and optional rewritten request. Rule order is deterministic. Tests pin precedence so a later low-risk rule cannot shadow a critical deny.

## Zcash integration

The preferred real integration is the official `zingolib_beta_ironwood` Zingo CLI tag on testnet. It is a light client backed by a remote indexer, avoiding a local full-node sync. The beta is currently necessary because testnet activated Ironwood/NU6.3 after the stable v5 release. ShadeGuard invokes a reviewed subset through an argument vector with `shell: false`: `spendable_balance`, `addresses`, `quicksend`, and `transactions`. Exact spendable balance is reduced to a boolean inside the adapter; the full transaction response is searched internally for one txid and never crosses the provider interface.

Zingo's broad commands such as `recovery_info`, `export_ufvk`, `messages`, `notes`, or a raw command passthrough have no mapping. CLI output and execution time are bounded, wallet commands are serialized, and only HTTPS indexers or loopback HTTP are accepted. The wallet directory is local, ignored, and mode `0700`.

The existing Zallet/Zaino/Zebra path remains an optional full-node adapter. Zallet is currently beta, so this is an adapter choice rather than a core dependency.

At startup the adapter calls `rpc.discover` and builds an allowlisted capability map. It requires only methods needed for the configured operations and never invokes key-export, full-history, or unrestricted note-list methods. For sending, the preferred method is `z_sendfromaccount` with `FullPrivacy`. If the method or privacy parameter is unavailable, `SEND_SHIELDED` is unavailable. There is no permissive fallback.

Versions used by both paths are pinned rather than tracking `latest`. Upgrades must repeat command/RPC contract tests and testnet integration tests.

## Agent and web execution boundary

The natural-language endpoint is preview-only: Gemini or NVIDIA NIM proposes a capability and the gateway's deterministic engine inspects it without downstream execution. Real wallet actions use separate typed endpoints and explicit UI actions. A shielded send is never inferred and executed from free text. The retro console binds only to loopback, rejects cross-origin mutation requests, applies a restrictive CSP, limits request bodies and rate-limits agent analysis. Provider API keys exist only in the server environment.

## Approval model

An approval is bound to a hash of the complete canonical request, decision reason, expiry, and random nonce. Approval data never includes secrets. Tokens are one-use; changed amount, recipient, memo, purpose, or requester invalidates them. A mode-`0600` local Unix socket lets the terminal CLI list and approve pending requests; the token stays inside the gateway and is never returned to the agent. The first implementation is local and single-process. A durable multi-instance store is intentionally deferred until its concurrency and encryption properties can be specified.

## Observability

Audit events include timestamp, request ID, requester ID, capability, risk, decision, reason code, provider name, and structurally redacted parameters. The redactor uses an allowlist; it does not attempt to blacklist every possible secret field. Amounts may be recorded only when needed for spending-policy accountability. Recipient addresses are hashed by default. Memos and raw provider responses are never logged. Send execution is serialized, and spend is reserved in an append-only local ledger before the provider call so concurrent requests or a gateway restart cannot reset the daily limit.

Operational logs go to stderr because stdout is reserved for MCP stdio transport.

## Delivery slices

1. Core policy engine + test doubles + MCP server/client demo.
2. Minimum-information balance behavior and leakage tests.
3. PII memo rewrite with explicit acceptance.
4. Viewing-key/history least-authority denials.
5. Zingo CLI light-wallet adapter plus optional pinned Zallet/Zaino/Zebra profile.
6. Gemini/NVIDIA NIM intent-explanation adapter and retro privacy console.
7. Paid HTTP 402 demo backed by a real testnet payment. The loopback demo service issues a shielded payment requirement, verifies only the supplied incoming txid in its separate merchant wallet, and releases the protected response after confirmation.

The blockchain acceptance slice was completed on 2026-08-17: a locally generated Zingo development wallet received testnet ZEC, ShadeGuard broadcast a shielded transfer through its MCP safe tool, and the task-scoped status returned `CONFIRMED` through MCP. The repeatable live command remains explicitly gated because it spends testnet funds and depends on an external indexer. Evidence and txids are recorded in [live-acceptance.md](live-acceptance.md).

## Upstream facts used by this design

- Zallet documents separate `zebra` and `zaino` backends; Zaino is the supported choice for separate containers, non-Linux hosts, and regtest: <https://zcash.github.io/zallet/guide/installation/index.html>
- Zallet exposes a generated OpenRPC document through `rpc.discover`: <https://zcash.github.io/zallet/rpc/index.html>
- `z_sendfromaccount` accepts an explicit fund source and privacy policy and returns a transaction ID synchronously: <https://zcash.github.io/zallet/rpc/index.html#z_sendfromaccount>
- MCP SDK v2 separates server and client packages: <https://github.com/modelcontextprotocol/typescript-sdk>
- Zingo's official Ironwood beta tag supports the current testnet transaction format: <https://github.com/zingolabs/zingolib/tree/zingolib_beta_ironwood/zingo-cli>
- Google recommends the production-ready `@google/genai` SDK for Gemini: <https://ai.google.dev/gemini-api/docs/libraries>
- NVIDIA exposes `meta/llama-3.1-8b-instruct` through a free prototyping endpoint: <https://build.nvidia.com/meta/llama-3_1-8b-instruct/deploy>
