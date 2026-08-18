# ShadeGuard threat model

## Scope

This document covers the ShadeGuard gateway, its MCP and wallet-adapter boundaries, locally held **testnet-only** wallet material, policy configuration, approvals, and privacy-safe observability. Zcash consensus cryptography, host compromise, provider implementation correctness, and mainnet funds are outside the guarantees of this MVP.

The system protects against accidental overreach by an AI agent, prompt-injected tool requests, an honest-but-curious model/provider, overly broad downstream wallet APIs, and common logging/approval mistakes. It does not claim to make a fully compromised user machine safe.

## Assets

- Spending authority and encrypted testnet seed material.
- Viewing authority and the shielded transaction graph it can reveal.
- Exact balances, note inventory, full transaction history, and account metadata.
- Recipient relationships, payment purposes, memos, and user PII.
- Policy configuration, daily spend state, and pending approvals.
- Integrity of the MCP tool surface and adapter capability mapping.

## Trust boundaries

| Boundary | Trust assumption | Required control |
| --- | --- | --- |
| Agent -> ShadeGuard | Untrusted and possibly prompt-injected | Schema validation, canonicalization, deterministic policy |
| LLM provider -> ShadeGuard | Untrusted advisory output | No decision authority; privacy-minimized context |
| ShadeGuard -> Zingo CLI/MCP/RPC | Provider may be broad, changed, or malformed | Allowlisted mappings/commands, no shell, timeouts, response validation |
| ShadeGuard -> audit/operations | Operators need decisions, not wallet contents | Allowlist redaction, secret-pattern tests, stderr separation |
| User -> approval service | User intent is authoritative for scoped action | Request digest binding, expiry, one-use consumption |
| Local process -> wallet storage | Host is trusted for MVP | Ignored local directory, restrictive permissions, no chat/repo transfer |

## Threats and mitigations

### T1 — Exact balance or wallet graph disclosure

An agent asks for a full balance, notes, addresses, or transaction history although it only needs to make one payment.

Mitigations: these capabilities are absent from the MCP registry; canonical attempts are denied or rewritten to `CAN_AFFORD`; adapter return types cannot represent an exact balance at the gateway boundary; leakage tests scan responses, AI context, and audits.

### T2 — Export of persistent authority

An agent requests a spending key, seed, private key, full viewing key, or incoming viewing key.

Mitigations: critical deterministic deny; no upstream tool; no downstream mapping; secret-shaped fields rejected from audit serialization. User approval cannot override critical key-export denies in the MVP.

### T3 — PII embedded in a shielded memo

An agent includes an email, phone number, stable user identifier, secret, or descriptive purchase metadata in a memo.

Mitigations: explicit memo text is removed locally before a hosted AI request; deterministic PII and secret-pattern detection; return a memo-free rewrite; require explicit acceptance of the exact rewritten request; never log the original memo. Detection is deliberately conservative and cannot prove arbitrary free text safe, so production policy should prefer empty memos.

### T4 — Privacy downgrade

An agent selects a transparent receiver, a non-`FullPrivacy` policy, cross-pool behavior, or a provider method whose privacy semantics are unknown.

Mitigations: address classification; testnet-only enforcement; transparent/unknown recipient denial; the Zingo adapter accepts only shielded recipients; missing or changed command semantics make the capability unavailable.

### T5 — Overspending and confused deputy behavior

Prompt injection changes amount, recipient, or purpose, or reuses ShadeGuard's authority for an unrelated payment.

Mitigations: per-transaction and rolling daily limits; append-only pre-execution spend reservations; serialized send execution; optional recipient allowlist; purpose required for send; approval bound to the full request digest and requester identity; no raw send API. A failed provider call keeps its reservation, preferring a conservative false rejection over an overspend.

### T6 — Approval replay or substitution

An approved token is reused, raced, or applied to a modified payment.

Mitigations: cryptographically random IDs/nonces, canonical request digest, expiry, one-use state transition in the single-process store. Multi-instance deployment is unsupported until an atomic shared store exists.

### T7 — Downstream tool expansion or schema drift

A wallet/MCP upgrade introduces new tools, removes a parameter, or changes response semantics.

Mitigations: never proxy `tools/list`; allowlisted provider mappings/CLI commands only; version/capability probing; strict response parsing; pinned testnet versions; fail-closed startup and integration contract tests.

### T8 — Sensitive logs and MCP stdout corruption

Raw inputs, provider errors, or secrets enter logs; diagnostic output on stdout corrupts stdio MCP or reaches the host.

Mitigations: audit allowlist, address hashing, no memo/provider payload fields, error normalization, secret canary tests, diagnostics on stderr only, restrictive audit-file permissions.

### T9 — Malicious or hallucinated LLM output

An LLM labels a dangerous request safe or injects extra fields/tool names.

Mitigations: LLM output is parsed as untrusted intent, normalized to a closed enum, then evaluated like any agent request; policy does not consume model risk labels or allow decisions; AI can be disabled completely.

### T10 — Network privacy leakage to infrastructure

Even shielded transactions can expose IP/timing information to a Zingo indexer.

Mitigations for MVP: document the selected Zingo indexer and residual metadata risk; keep wallet keys client-side; bind all local services to loopback. Tor/Nym transport and broadcast timing defenses are future hardening, not current guarantees.

### T11 — SSRF and credential exfiltration through provider configuration

An attacker changes an RPC URL or returns malicious content to access local services or leak credentials.

Mitigations: Zingo indexers require HTTPS except for loopback HTTP; configured URLs reject embedded credentials; subprocess response sizes and timeouts are bounded.

### T12 — Mainnet use by mistake

Test code is pointed at mainnet or receives a mainnet address.

Mitigations: `testnet` is an invariant in the MVP, not merely a default; startup and recipient classification reject mainnet; docs prohibit mainnet keys and funds.

### T13 — Browser/API credential or action exposure

A hosted AI API key is bundled into frontend assets, a remote site calls the local approval/send endpoints, or the console is accidentally exposed to the LAN.

Mitigations: NVIDIA NIM calls run server-side and keys are read only from an ignored environment file; the server binds only to loopback; mutation requests reject foreign origins; CSP and frame denial prevent common browser embedding; request bodies and agent calls are bounded. The local host remains trusted for the MVP.

## Abuse cases that must remain in tests

- `READ_EXACT_BALANCE` never returns or logs the mock provider's exact number.
- Key/viewing-key export is critical deny even with an approval token.
- Unknown capabilities never call the provider.
- PII memo content is absent from result and audit events; only a safe rewrite is returned.
- A changed amount or recipient invalidates approval.
- A consumed approval cannot be used twice.
- Transparent and mainnet recipients cannot reach the shielded-send adapter path.
- Downstream methods discovered after an upgrade are not exposed upstream.
- Provider errors containing secret canaries are normalized before logging.

## Residual risks before production

- Regex-based PII detection has false positives and false negatives.
- A local single-process approval store does not survive restart and is not horizontally safe.
- Zingo CLI and its command JSON are evolving; a version check does not replace transaction-level integration testing.
- A remote Zingo indexer can observe IP, timing, and relevant block-query metadata.
- The TypeScript process and wallet process share host trust in local development.
- No independent security audit has been performed.

These risks are acceptable only for the testnet MVP. Mainnet must remain technically disabled until storage, operations, dependency pinning, network privacy, and policy implementation receive a dedicated review.
