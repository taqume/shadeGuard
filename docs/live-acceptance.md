# Live testnet acceptance

Last verified: 2026-08-17 on Zcash public testnet with the pinned Zingo CLI Ironwood beta.

## MCP shielded payment

- Source: local development wallet A (secret material remains under `.shadeguard/`).
- Recipient: independent local development wallet B.
- Amount: `0.01 TAZ` plus the network fee.
- Safe MCP surface: `shadeguard_can_afford`, `shadeguard_safe_send`, and `shadeguard_get_payment_status`.
- Policy result: `ALLOW / LOW / SAFE_CAPABILITY`.
- Transaction: `e610832f4cdd3a8a3f46f4318aaf82f21798b8efd11f6d016184b18dbbbaa24f`.
- Final task-scoped status returned through MCP: `CONFIRMED`.

The MCP response and privacy-safe audit contain no exact wallet balance, seed, key, raw memo, or full transaction history.

## HTTP 402 paid API

The loopback demo returned `402 PAYMENT_REQUIRED` without a payment proof. The client then used the same ShadeGuard MCP surface and the merchant service checked only the supplied txid inside wallet B. A confirmed incoming payment meeting the minimum amount returned `200 OK` and unlocked the protected response.

The end-to-end paid-flow transaction was broadcast as
`d5cedb4ec4dcee7f0ab203f8e0a5ac098653e5afe3796d8aacd79d94fd4c940b`.
While it was in the mempool the paid API correctly remained at `402 PAYMENT_NOT_CONFIRMED`; after confirmation the same proof returned `200 OK`. A verification interrupted after broadcast can continue without creating another payment:

```bash
PAID_API_PAYMENT_ID='d5cedb4ec4dcee7f0ab203f8e0a5ac098653e5afe3796d8aacd79d94fd4c940b' pnpm paid-api:client
```

These transaction IDs are public testnet identifiers, not wallet secrets.
